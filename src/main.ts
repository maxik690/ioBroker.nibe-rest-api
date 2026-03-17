/*
 * Created with @iobroker/create-adapter v3.1.2
 */

import * as utils from "@iobroker/adapter-core";
import { Buffer } from "node:buffer";
import * as https from "node:https";

type AidMode = "off" | "on";
type SmartMode = "normal" | "away";

interface DeviceSummary {
    deviceIndex: number;
    aidMode: AidMode;
    smartMode: SmartMode;
    product: {
        serialNumber: string;
        name: string;
        manufacturer: string;
        firmwareId: string;
    };
}

interface DevicesResponse {
    devices: DeviceSummary[];
}

interface PointMetadata {
    type: "metadata";
    variableId: number;
    variableType: string;
    variableSize: string;
    unit: string;
    modbusRegisterType: string;
    shortUnit: string;
    isWritable: boolean;
    divisor: number;
    decimal: number;
    modbusRegisterID: number;
    minValue: number;
    maxValue: number;
    intDefaultValue: number;
    change: number;
    stringDefaultValue: string;
}

interface PointDataValue {
    type: "datavalue";
    isOk: boolean;
    variableId: number;
    integerValue?: number;
    stringValue?: string;
}

interface PointValue {
    title: string;
    description: string;
    metadata: PointMetadata;
    datavalue: PointDataValue;
}

type PointsResponse = Record<string, unknown>;

interface NotificationEntry {
    alarmId: number;
    description: string;
    header: string;
    severity: number;
    time: string;
    equipName: string;
}

interface NotificationsResponse {
    alarms: NotificationEntry[];
}

type RequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface RequestOptions {
    method?: RequestMethod;
    path: string;
    body?: unknown;
}

interface UpsertStateOptions {
    name?: string;
    type?: ioBroker.CommonType;
    role?: string;
    read?: boolean;
    write?: boolean;
    unit?: string;
    desc?: string;
    min?: number;
    max?: number;
    states?: ioBroker.StateCommon["states"];
    native?: Record<string, unknown>;
}

interface WritablePointDescriptor {
    deviceId: string;
    pointId: number;
    metadata: PointMetadata;
}

interface DeviceModeDescriptor {
    deviceId: string;
    kind: "aidMode" | "smartMode";
}

interface NormalizedPointEntry {
    pointId: number;
    point: PointValue;
}

interface ErrorResponsePayload {
    error?: string;
}

type PointWriteResultValue = string | number | boolean | Record<string, unknown> | null;

const INVISIBLE_WORD_JOINERS =
    /\u00AD|\u034F|\u061C|\u115F|\u1160|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u200B|\u200C|\u200D|\u200E|\u200F|\u202A|\u202B|\u202C|\u202D|\u202E|\u2060|\u2061|\u2062|\u2063|\u2064|\u2065|\u2066|\u2067|\u2068|\u2069|\u206A|\u206B|\u206C|\u206D|\u206E|\u206F|\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F|\uFEFF/gu;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** ioBroker adapter for synchronizing NIBE heat pump data via the local REST API. */
export class NibeRestApi extends utils.Adapter {
    private pollTimer: ioBroker.Timeout | undefined;
    private pollInProgress = false;
    private readonly writablePoints = new Map<string, WritablePointDescriptor>();
    private readonly deviceModes = new Map<string, DeviceModeDescriptor>();
    private readonly loggedUnknownPointShapes = new Set<string>();
    private readonly lastSuccessfulWrites = new Map<string, number>();

    /**
     * Creates the adapter instance with the standard ioBroker lifecycle handlers.
     *
     * @param options Adapter options supplied by ioBroker during startup or tests.
     */
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: "nibe-rest-api",
        });

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState("info.connection", false, true);
        await this.setObjectNotExistsAsync("info.lastSync", {
            type: "state",
            common: {
                name: "Last successful synchronization",
                type: "string",
                role: "value.time",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.lastError", {
            type: "state",
            common: {
                name: "Last error message",
                type: "string",
                role: "text",
                read: true,
                write: false,
            },
            native: {},
        });

        if (!this.config.baseUrl?.trim()) {
            this.log.error("Missing base URL. Please configure the adapter first.");
            await this.setState("info.lastError", "Missing base URL", true);
            return;
        }

        if (!this.getAuthorizationHeaderValue()) {
            this.log.error("Missing authentication. Configure username/password or a Basic auth hash.");
            await this.setState("info.lastError", "Missing authentication", true);
            return;
        }

        this.subscribeStates("devices.*");
        await this.pollApi();
    }

    private onUnload(callback: () => void): void {
        try {
            if (this.pollTimer) {
                clearTimeout(this.pollTimer);
                this.pollTimer = undefined;
            }
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${(error as Error).message}`);
            callback();
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }

        const stateId = id.replace(`${this.namespace}.`, "");

        try {
            if (this.deviceModes.has(stateId)) {
                this.ensureWriteLockElapsed(stateId);
                await this.handleModeWrite(stateId, state.val);
                this.lastSuccessfulWrites.set(stateId, Date.now());
                return;
            }

            if (this.writablePoints.has(stateId)) {
                this.ensureWriteLockElapsed(stateId);
                await this.handlePointWrite(stateId, state.val);
                this.lastSuccessfulWrites.set(stateId, Date.now());
                return;
            }

            this.log.debug(`Ignoring unsupported write to ${stateId}`);
        } catch (error) {
            const message = (error as Error).message;
            this.log.error(`Failed to process write for ${stateId}: ${message}`);
            await this.setState("info.lastError", message, true);
            await this.refreshSingleState(stateId);
        }
    }

    private scheduleNextPoll(): void {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }
        const intervalSeconds = Math.max(Number(this.config.pollInterval) || 30, 5);
        this.pollTimer = this.setTimeout(() => {
            void this.pollApi();
        }, intervalSeconds * 1000);
    }

    private async pollApi(): Promise<void> {
        if (this.pollInProgress) {
            this.log.debug("Polling still running, skipping this cycle");
            this.scheduleNextPoll();
            return;
        }

        this.pollInProgress = true;
        const pollStartedAt = Date.now();

        try {
            const devicesRequestStartedAt = Date.now();
            const devicesResponse = await this.apiRequest<DevicesResponse>({ path: "/api/v1/devices" });
            const devicesResponseDurationMs = Date.now() - devicesRequestStartedAt;
            const devices = this.filterConfiguredDevices(devicesResponse.devices ?? []);
            this.log.debug(
                `Poll devices response in ${devicesResponseDurationMs}ms, ${devices.length} device(s) selected from ${devicesResponse.devices?.length ?? 0}`,
            );

            for (const device of devices) {
                await this.syncDevice(device);
            }

            await this.setState("info.connection", true, true);
            await this.setState("info.lastSync", new Date().toISOString(), true);
            await this.setState("info.lastError", "", true);
        } catch (error) {
            const message = (error as Error).message;
            this.log.error(`Polling failed: ${message}`);
            await this.setState("info.connection", false, true);
            await this.setState("info.lastError", message, true);
        } finally {
            this.log.debug(`Poll cycle finished in ${Date.now() - pollStartedAt}ms`);
            this.pollInProgress = false;
            this.scheduleNextPoll();
        }
    }

    private filterConfiguredDevices(devices: DeviceSummary[]): DeviceSummary[] {
        const configuredIds = this.config.deviceIds
            ?.split(",")
            .map(id => id.trim())
            .filter(Boolean);

        if (!configuredIds?.length) {
            return devices;
        }

        const configuredSet = new Set(configuredIds);
        return devices.filter(
            device => configuredSet.has(String(device.deviceIndex)) || configuredSet.has(device.product.serialNumber),
        );
    }

    private async syncDevice(device: DeviceSummary): Promise<void> {
        const deviceId = device.product.serialNumber || String(device.deviceIndex);
        const devicePath = `devices.${this.sanitizeSegment(deviceId)}`;
        const syncStartedAt = Date.now();

        await this.ensureDeviceObjects(devicePath);
        await this.syncDeviceSummary(devicePath, deviceId, device);
        await this.syncPoints(devicePath, deviceId);

        if (this.config.fetchNotifications) {
            await this.syncNotifications(devicePath, deviceId);
        }

        this.log.debug(`Poll device ${deviceId} synchronized in ${Date.now() - syncStartedAt}ms`);
    }

    private async ensureDeviceObjects(devicePath: string): Promise<void> {
        await this.setObjectNotExistsAsync(devicePath, {
            type: "channel",
            common: { name: "Device" },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${devicePath}.product`, {
            type: "channel",
            common: { name: "Product" },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${devicePath}.points`, {
            type: "channel",
            common: { name: "Points" },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${devicePath}.points.readOnly`, {
            type: "channel",
            common: { name: "Read-only points" },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${devicePath}.points.writable`, {
            type: "channel",
            common: { name: "Writable points" },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${devicePath}.notifications`, {
            type: "channel",
            common: { name: "Notifications" },
            native: {},
        });
    }

    private async syncDeviceSummary(devicePath: string, deviceId: string, device: DeviceSummary): Promise<void> {
        await this.upsertState(`${devicePath}.deviceIndex`, {
            name: "Device index",
            role: "value",
            type: "number",
            read: true,
            write: false,
        });
        await this.upsertState(`${devicePath}.aidMode`, {
            name: "Aid mode",
            role: "state",
            type: "string",
            read: true,
            write: true,
            states: {
                off: "off",
                on: "on",
            },
        });
        await this.upsertState(`${devicePath}.smartMode`, {
            name: "Smart mode",
            role: "state",
            type: "string",
            read: true,
            write: true,
            states: {
                normal: "normal",
                away: "away",
            },
        });
        await this.upsertState(`${devicePath}.product.serialNumber`, {
            name: "Serial number",
            role: "text",
            type: "string",
            read: true,
            write: false,
        });
        await this.upsertState(`${devicePath}.product.name`, {
            name: "Name",
            role: "text",
            type: "string",
            read: true,
            write: false,
        });
        await this.upsertState(`${devicePath}.product.manufacturer`, {
            name: "Manufacturer",
            role: "text",
            type: "string",
            read: true,
            write: false,
        });
        await this.upsertState(`${devicePath}.product.firmwareId`, {
            name: "Firmware ID",
            role: "text",
            type: "string",
            read: true,
            write: false,
        });

        this.deviceModes.set(`${devicePath}.aidMode`, { deviceId, kind: "aidMode" });
        this.deviceModes.set(`${devicePath}.smartMode`, { deviceId, kind: "smartMode" });

        await this.setState(`${devicePath}.deviceIndex`, device.deviceIndex, true);
        await this.setState(`${devicePath}.aidMode`, device.aidMode, true);
        await this.setState(`${devicePath}.smartMode`, device.smartMode, true);
        await this.setState(`${devicePath}.product.serialNumber`, device.product.serialNumber, true);
        await this.setState(`${devicePath}.product.name`, device.product.name, true);
        await this.setState(`${devicePath}.product.manufacturer`, device.product.manufacturer, true);
        await this.setState(`${devicePath}.product.firmwareId`, device.product.firmwareId, true);
    }

    private async syncPoints(devicePath: string, deviceId: string): Promise<void> {
        const pointsRequestStartedAt = Date.now();
        const points = await this.apiRequest<PointsResponse>({
            path: `/api/v1/devices/${encodeURIComponent(deviceId)}/points`,
        });
        const pointsResponseDurationMs = Date.now() - pointsRequestStartedAt;
        const pointsPreparationStartedAt = Date.now();

        let skippedPoints = 0;
        const normalizedPoints: NormalizedPointEntry[] = [];

        for (const [pointKey, rawPoint] of Object.entries(points)) {
            const pointId = Number(pointKey);
            if (!Number.isFinite(pointId)) {
                continue;
            }

            const point = this.normalizePointValue(rawPoint, pointId);
            if (!this.isValidPointValue(point)) {
                skippedPoints++;
                this.logUnknownPointShapeOnce(deviceId, pointId, rawPoint);
                continue;
            }

            normalizedPoints.push({ pointId, point });
        }

        const pointNameCounts = new Map<string, number>();
        for (const { point } of normalizedPoints) {
            const pointGroup = point.metadata.isWritable ? "writable" : "readOnly";
            const baseName = this.getPointStateBaseName(point.title);
            const countKey = `${pointGroup}:${baseName}`;
            pointNameCounts.set(countKey, (pointNameCounts.get(countKey) ?? 0) + 1);
        }

        for (const { pointId, point } of normalizedPoints) {
            const pointGroupPath = point.metadata.isWritable
                ? `${devicePath}.points.writable`
                : `${devicePath}.points.readOnly`;
            const baseName = this.getPointStateBaseName(point.title);
            const countKey = `${point.metadata.isWritable ? "writable" : "readOnly"}:${baseName}`;
            const pointStateId = (pointNameCounts.get(countKey) ?? 0) > 1 ? `${baseName}_${pointId}` : baseName;
            const pointPath = `${pointGroupPath}.${pointStateId}`;

            await this.upsertState(pointPath, {
                name: point.title || `Point ${pointId}`,
                role: this.determinePointRole(point.metadata),
                type: this.determineIoBrokerType(point.metadata),
                read: true,
                write: point.metadata.isWritable,
                unit: point.metadata.shortUnit || point.metadata.unit || undefined,
                desc: this.buildPointDescription(point.description, pointId),
                native: {
                    pointId,
                    deviceId,
                    title: point.title,
                    isWritable: point.metadata.isWritable,
                    variableId: point.metadata.variableId,
                },
            });

            if (point.metadata.isWritable) {
                this.writablePoints.set(pointPath, {
                    deviceId,
                    pointId,
                    metadata: point.metadata,
                });
            } else {
                this.writablePoints.delete(pointPath);
            }

            await this.setState(pointPath, {
                val: this.convertPointToStateValue(point),
                ack: true,
                q: point.datavalue.isOk ? 0 : 0x01,
            });
        }

        if (skippedPoints > 0) {
            this.log.debug(`Skipped ${skippedPoints} invalid points on device ${deviceId}`);
        }

        this.log.debug(
            `Poll points for device ${deviceId}: response ${pointsResponseDurationMs}ms, preparation ${Date.now() - pointsPreparationStartedAt}ms, ${normalizedPoints.length} point(s)`,
        );
    }

    private async syncNotifications(devicePath: string, deviceId: string): Promise<void> {
        const notificationsRequestStartedAt = Date.now();
        const notifications = await this.apiRequest<NotificationsResponse>({
            path: `/api/v1/devices/${encodeURIComponent(deviceId)}/notifications`,
        });
        const notificationsResponseDurationMs = Date.now() - notificationsRequestStartedAt;
        const notificationsPreparationStartedAt = Date.now();

        await this.upsertState(`${devicePath}.notifications.activeCount`, {
            name: "Active notifications",
            role: "value",
            type: "number",
            read: true,
            write: false,
        });
        await this.upsertState(`${devicePath}.notifications.json`, {
            name: "Notifications JSON",
            role: "json",
            type: "string",
            read: true,
            write: false,
        });

        await this.setState(`${devicePath}.notifications.activeCount`, notifications.alarms.length, true);
        await this.setState(`${devicePath}.notifications.json`, JSON.stringify(notifications.alarms), true);
        this.log.debug(
            `Poll notifications for device ${deviceId}: response ${notificationsResponseDurationMs}ms, preparation ${Date.now() - notificationsPreparationStartedAt}ms, ${notifications.alarms.length} alarm(s)`,
        );
    }

    private async handleModeWrite(stateId: string, value: ioBroker.StateValue): Promise<void> {
        const descriptor = this.deviceModes.get(stateId);
        if (!descriptor) {
            return;
        }

        const normalizedValue = String(value);
        const path =
            descriptor.kind === "aidMode"
                ? `/api/v1/devices/${encodeURIComponent(descriptor.deviceId)}/aidmode`
                : `/api/v1/devices/${encodeURIComponent(descriptor.deviceId)}/smartmode`;
        const body = descriptor.kind === "aidMode" ? { aidMode: normalizedValue } : { smartMode: normalizedValue };

        this.log.debug(`Writing mode ${stateId} via ${path} with payload: ${this.formatUnknownForLog(body)}`);
        const response = await this.apiRequest<unknown>({ method: "POST", path, body });
        this.log.debug(`Write response for mode ${stateId}: ${this.formatUnknownForLog(response)}`);
        await this.setState(stateId, normalizedValue, true);
        await this.pollApi();
    }

    private async handlePointWrite(stateId: string, value: ioBroker.StateValue): Promise<void> {
        const descriptor = this.writablePoints.get(stateId);
        if (!descriptor) {
            return;
        }

        const payload: PointDataValue = {
            type: "datavalue",
            isOk: true,
            variableId: descriptor.pointId,
        };

        if (descriptor.metadata.variableType === "binary") {
            payload.integerValue = value ? 1 : 0;
        } else if (this.isStringLikeType(descriptor.metadata.variableType)) {
            payload.stringValue = value == null ? "" : String(value);
        } else {
            payload.integerValue = this.scalePointWriteValue(value, descriptor.metadata);
        }

        this.log.debug(
            `Writing point ${stateId} (${descriptor.pointId}) with payload: ${this.formatUnknownForLog(payload)}`,
        );
        const result = await this.apiRequest<Record<string, PointWriteResultValue>>({
            method: "PATCH",
            path: `/api/v1/devices/${encodeURIComponent(descriptor.deviceId)}/points`,
            body: [payload],
        });
        this.log.debug(
            `Write response for point ${stateId} (${descriptor.pointId}): ${this.formatUnknownForLog(result)}`,
        );

        const resultValue = result[String(descriptor.pointId)];
        if (!this.isAcceptedPointWriteResult(resultValue, descriptor.pointId)) {
            throw new Error(`API rejected point ${descriptor.pointId}: ${this.formatApiResultValue(resultValue)}`);
        }

        const updatedPoint = this.extractWritablePointFromWriteResult(resultValue, descriptor.pointId);
        if (updatedPoint) {
            await this.setState(stateId, {
                val: this.convertPointToStateValue(updatedPoint),
                ack: true,
                q: updatedPoint.datavalue.isOk ? 0 : 0x01,
            });
            return;
        }

        await this.refreshSingleState(stateId);
    }

    private async refreshSingleState(stateId: string): Promise<void> {
        const pointDescriptor = this.writablePoints.get(stateId);
        if (pointDescriptor) {
            const response = await this.apiRequest<unknown>({
                path: `/api/v1/devices/${encodeURIComponent(pointDescriptor.deviceId)}/points/${pointDescriptor.pointId}`,
            });
            const point = this.extractPointValue(response, pointDescriptor.pointId);
            if (!this.isValidPointValue(point)) {
                throw new Error(`Point ${pointDescriptor.pointId} has no metadata or datavalue`);
            }
            await this.setState(stateId, this.convertPointToStateValue(point), true);
            return;
        }

        const deviceDescriptor = this.deviceModes.get(stateId);
        if (deviceDescriptor) {
            const device = await this.apiRequest<DeviceSummary>({
                path: `/api/v1/devices/${encodeURIComponent(deviceDescriptor.deviceId)}`,
            });
            const value = deviceDescriptor.kind === "aidMode" ? device.aidMode : device.smartMode;
            await this.setState(stateId, value, true);
        }
    }

    private convertPointToStateValue(point: PointValue): ioBroker.StateValue {
        const { metadata, datavalue } = point;

        if (!datavalue) {
            return null;
        }

        if (metadata.variableType === "binary") {
            return Boolean(datavalue.integerValue);
        }

        if (this.isStringLikeType(metadata.variableType)) {
            return datavalue.stringValue ?? "";
        }

        if (typeof datavalue.integerValue === "number") {
            return this.scalePointReadValue(datavalue.integerValue, metadata);
        }

        if (typeof datavalue.stringValue === "string") {
            return datavalue.stringValue;
        }

        return null;
    }

    private determineIoBrokerType(metadata: PointMetadata): ioBroker.CommonType {
        if (metadata.variableType === "binary") {
            return "boolean";
        }

        if (this.isStringLikeType(metadata.variableType)) {
            return "string";
        }

        return "number";
    }

    private determinePointRole(metadata: PointMetadata): string {
        if (metadata.variableType === "binary") {
            return metadata.isWritable ? "switch" : "indicator";
        }

        if (
            metadata.variableType === "string" ||
            metadata.variableType === "date" ||
            metadata.variableType === "time"
        ) {
            return "text";
        }

        if (metadata.shortUnit === "°C" || metadata.unit === "°C") {
            return "value.temperature";
        }

        return "value";
    }

    private scalePointReadValue(integerValue: number, metadata: PointMetadata): number {
        const divisor = metadata.divisor || 1;
        return integerValue / divisor;
    }

    private scalePointWriteValue(value: ioBroker.StateValue, metadata: PointMetadata): number {
        const numericValue = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(numericValue)) {
            throw new Error(`Invalid numeric value: ${value}`);
        }

        const divisor = metadata.divisor || 1;
        return Math.round(numericValue * divisor);
    }

    private isStringLikeType(variableType: string): boolean {
        return (
            variableType === "string" ||
            variableType === "time" ||
            variableType === "date" ||
            variableType === "unknown"
        );
    }

    private ensureWriteLockElapsed(stateId: string): void {
        const lockIntervalMs = this.getWriteLockIntervalMs();
        if (lockIntervalMs <= 0) {
            return;
        }

        const lastWrite = this.lastSuccessfulWrites.get(stateId);
        if (!lastWrite) {
            return;
        }

        const now = Date.now();
        const elapsedMs = now - lastWrite;
        if (elapsedMs >= lockIntervalMs) {
            return;
        }

        const remainingSeconds = Math.ceil((lockIntervalMs - elapsedMs) / 1000);
        throw new Error(`Write lock active for ${stateId}. Try again in ${remainingSeconds}s`);
    }

    private getWriteLockIntervalMs(): number {
        const lockIntervalSeconds = Math.max(Number(this.config.writeLockInterval) || 120, 0);
        return lockIntervalSeconds * 1000;
    }

    private getAuthorizationHeaderValue(): string | undefined {
        if (this.config.basicAuth?.trim()) {
            return `Basic ${this.config.basicAuth.trim()}`;
        }

        if (!this.config.username?.trim() && !this.config.password?.trim()) {
            return undefined;
        }

        const token = Buffer.from(`${this.config.username ?? ""}:${this.config.password ?? ""}`).toString("base64");
        return `Basic ${token}`;
    }

    private async apiRequest<T>(options: RequestOptions): Promise<T> {
        const baseUrl = new URL(this.config.baseUrl);
        const requestPath = new URL(options.path, `${baseUrl.origin}/`);
        const body = options.body == null ? undefined : JSON.stringify(options.body);
        const headers: Record<string, string> = {
            Accept: "application/json",
            Authorization: this.getAuthorizationHeaderValue() ?? "",
        };

        if (body) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(body).toString();
        }

        return await new Promise<T>((resolve, reject) => {
            const request = https.request(
                {
                    protocol: requestPath.protocol,
                    hostname: requestPath.hostname,
                    port: requestPath.port,
                    path: `${requestPath.pathname}${requestPath.search}`,
                    method: options.method ?? "GET",
                    headers,
                    agent: new https.Agent({
                        rejectUnauthorized: !this.config.ignoreTlsErrors,
                    }),
                },
                response => {
                    let rawData = "";

                    response.setEncoding("utf8");
                    response.on("data", chunk => {
                        rawData += chunk;
                    });
                    response.on("end", () => {
                        const statusCode = response.statusCode ?? 500;
                        if (statusCode < 200 || statusCode >= 300) {
                            let message = `HTTP ${statusCode}`;
                            try {
                                const parsed = rawData ? (JSON.parse(rawData) as ErrorResponsePayload) : undefined;
                                if (parsed?.error) {
                                    message = parsed.error;
                                }
                            } catch {
                                if (rawData) {
                                    message = rawData;
                                }
                            }
                            reject(new Error(message));
                            return;
                        }

                        if (!rawData) {
                            resolve(undefined as T);
                            return;
                        }

                        try {
                            resolve(JSON.parse(rawData) as T);
                        } catch {
                            resolve(rawData as T);
                        }
                    });
                },
            );

            request.on("error", reject);

            if (body) {
                request.write(body);
            }

            request.end();
        });
    }

    private extractPointValue(response: unknown, pointId: number): PointValue {
        const directPoint = this.normalizePointValue(response, pointId);
        if (directPoint) {
            return directPoint;
        }

        if (this.isRecord(response)) {
            const nestedPoint = this.normalizePointValue(response[String(pointId)], pointId);
            if (nestedPoint) {
                return nestedPoint;
            }
        }

        throw new Error(`Point ${pointId} not found in API response`);
    }

    private isValidPointValue(point: PointValue | undefined | null): point is PointValue {
        return !!point?.metadata && !!point.datavalue;
    }

    private normalizePointValue(rawPoint: unknown, pointId: number): PointValue | undefined {
        const candidates = this.collectPointCandidates(rawPoint, pointId);

        for (const candidate of candidates) {
            const metadata = this.extractMetadata(candidate);
            const datavalue = this.extractDataValue(candidate);
            if (!metadata || !datavalue) {
                continue;
            }

            return {
                title: this.readString(candidate.title) ?? `Point ${pointId}`,
                description: this.readString(candidate.description) ?? "",
                metadata,
                datavalue,
            };
        }

        return undefined;
    }

    private collectPointCandidates(rawPoint: unknown, pointId: number): Record<string, unknown>[] {
        if (!this.isRecord(rawPoint)) {
            return [];
        }

        const candidates: Record<string, unknown>[] = [rawPoint];
        const nestedByPointId = rawPoint[String(pointId)];
        if (this.isRecord(nestedByPointId)) {
            candidates.push(nestedByPointId);
        }

        for (const value of Object.values(rawPoint)) {
            if (this.isRecord(value)) {
                candidates.push(value);
            }
        }

        return candidates;
    }

    private extractMetadata(candidate: Record<string, unknown>): PointMetadata | undefined {
        const metadataCandidate = this.isRecord(candidate.metadata) ? candidate.metadata : candidate;
        if (!this.readString(metadataCandidate.variableType)) {
            return undefined;
        }

        return {
            type: "metadata",
            variableId: this.readNumber(metadataCandidate.variableId) ?? 0,
            variableType: this.readString(metadataCandidate.variableType) ?? "unknown",
            variableSize: this.readString(metadataCandidate.variableSize) ?? "",
            unit: this.readString(metadataCandidate.unit) ?? "",
            modbusRegisterType: this.readString(metadataCandidate.modbusRegisterType) ?? "",
            shortUnit: this.readString(metadataCandidate.shortUnit) ?? "",
            isWritable: this.readBoolean(metadataCandidate.isWritable) ?? false,
            divisor: this.readNumber(metadataCandidate.divisor) ?? 1,
            decimal: this.readNumber(metadataCandidate.decimal) ?? 0,
            modbusRegisterID: this.readNumber(metadataCandidate.modbusRegisterID) ?? 0,
            minValue: this.readNumber(metadataCandidate.minValue) ?? 0,
            maxValue: this.readNumber(metadataCandidate.maxValue) ?? 0,
            intDefaultValue: this.readNumber(metadataCandidate.intDefaultValue) ?? 0,
            change: this.readNumber(metadataCandidate.change) ?? 0,
            stringDefaultValue: this.readString(metadataCandidate.stringDefaultValue) ?? "",
        };
    }

    private extractDataValue(candidate: Record<string, unknown>): PointDataValue | undefined {
        const explicitDataValue = this.isRecord(candidate.datavalue)
            ? candidate.datavalue
            : this.isRecord(candidate.dataValue)
              ? candidate.dataValue
              : this.isRecord(candidate.value)
                ? candidate.value
                : undefined;

        const dataValueCandidate =
            explicitDataValue ||
            (typeof candidate.integerValue === "number" || typeof candidate.stringValue === "string"
                ? candidate
                : undefined);

        if (!dataValueCandidate) {
            return undefined;
        }

        const integerValue = this.readNumber(dataValueCandidate.integerValue);
        const stringValue = this.readString(dataValueCandidate.stringValue);
        if (integerValue === undefined && stringValue === undefined) {
            return undefined;
        }

        return {
            type: "datavalue",
            isOk: this.readBoolean(dataValueCandidate.isOk) ?? false,
            variableId: this.readNumber(dataValueCandidate.variableId) ?? 0,
            integerValue,
            stringValue,
        };
    }

    private logUnknownPointShapeOnce(deviceId: string, pointId: number, rawPoint: unknown): void {
        const logKey = `${deviceId}:${pointId}`;
        if (this.loggedUnknownPointShapes.has(logKey)) {
            return;
        }

        this.loggedUnknownPointShapes.add(logKey);

        let serialized = "";
        try {
            serialized = JSON.stringify(rawPoint);
        } catch {
            serialized = String(rawPoint);
        }

        this.log.debug(
            `Skipping point ${pointId} on device ${deviceId} because metadata or datavalue is missing. Raw sample: ${serialized.slice(0, 300)}`,
        );
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    private readString(value: unknown): string | undefined {
        return typeof value === "string" ? value : undefined;
    }

    private readNumber(value: unknown): number | undefined {
        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    }

    private readBoolean(value: unknown): boolean | undefined {
        return typeof value === "boolean" ? value : undefined;
    }

    private getPointStateBaseName(title: string): string {
        const sanitizedTitle = this.normalizeTitleForStateId(title)
            .replace(/\s+/g, "_")
            .replace(/[^a-zA-Z0-9_-]+/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "");

        return sanitizedTitle || "point";
    }

    private normalizeTitleForStateId(title: string): string {
        return title
            .normalize("NFKD")
            .replace(INVISIBLE_WORD_JOINERS, "")
            .replace(COMBINING_MARKS, "")
            .replace(/[^a-zA-Z0-9_-]+/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "");
    }

    private buildPointDescription(description: string, pointId: number): string {
        const trimmedDescription = description.trim();
        return trimmedDescription ? `${trimmedDescription}\nPoint ID: ${pointId}` : `Point ID: ${pointId}`;
    }

    private sanitizeSegment(value: string): string {
        return value.replace(this.FORBIDDEN_CHARS, "_");
    }

    private formatApiResultValue(value: PointWriteResultValue): string {
        if (typeof value === "string") {
            return value;
        }

        if (value == null) {
            return "null";
        }

        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }

        try {
            return JSON.stringify(value);
        } catch {
            return Object.prototype.toString.call(value);
        }
    }

    private formatUnknownForLog(value: unknown): string {
        if (typeof value === "string") {
            return value;
        }

        if (value == null) {
            return "null";
        }

        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }

        try {
            return JSON.stringify(value);
        } catch {
            return Object.prototype.toString.call(value);
        }
    }

    private isAcceptedPointWriteResult(value: PointWriteResultValue, pointId: number): boolean {
        if (value == null) {
            return true;
        }

        if (value === "modified") {
            return true;
        }

        if (!this.isRecord(value)) {
            return false;
        }

        return this.isValidPointValue(this.normalizePointValue(value, pointId));
    }

    private extractWritablePointFromWriteResult(value: PointWriteResultValue, pointId: number): PointValue | undefined {
        if (!this.isRecord(value)) {
            return undefined;
        }

        const point = this.normalizePointValue(value, pointId);
        return this.isValidPointValue(point) ? point : undefined;
    }

    private async upsertState(id: string, common: UpsertStateOptions): Promise<void> {
        await this.extendObjectAsync(id, {
            type: "state",
            common: {
                name: common.name ?? id,
                type: common.type ?? "string",
                role: common.role ?? "state",
                read: common.read ?? true,
                write: common.write ?? false,
                unit: common.unit,
                desc: common.desc,
                min: common.min,
                max: common.max,
                states: common.states,
            },
            native: common.native ?? {},
        });
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new NibeRestApi(options);
} else {
    (() => new NibeRestApi())();
}
