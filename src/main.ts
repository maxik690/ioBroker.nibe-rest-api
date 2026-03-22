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

interface PointStateDescriptor {
    deviceId: string;
    pointId: number;
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

interface DiscoveredPointCatalogEntry {
    deviceId: string;
    deviceName: string;
    pointId: number;
    title: string;
    writable: boolean;
    unit: string;
    stateId: string;
    currentValue: ioBroker.StateValue;
}

interface SelectOption {
    value: string | number;
    label: string;
}

interface KnownDeviceEntry {
    deviceId: string;
    deviceName: string;
}

interface CustomPointPollScheduleEntry {
    enabled: boolean;
    deviceId?: string;
    pointId: number;
    intervalMs: number;
}

interface ConfiguredCustomPointPollEntry {
    enabled: boolean;
    deviceId?: string;
    pointId: number;
    intervalProfileId?: string;
}

interface DiscoveryRequestConfig {
    baseUrl?: string;
    username?: string;
    password?: string;
    basicAuth?: string;
    ignoreTlsErrors?: boolean;
    deviceIds?: string;
}

interface MessagePayload {
    command?: string;
    message?: unknown;
    from?: string;
    callback?: ioBroker.MessageCallback | ioBroker.MessageCallbackInfo;
}

type PointWriteResultValue = string | number | boolean | Record<string, unknown> | null;
type CachedStateSnapshot = Pick<ioBroker.SettableState, "val" | "ack" | "q">;
const NO_ENABLED_DEVICES_MARKER = "__none__";

const INVISIBLE_WORD_JOINERS =
    /\u00AD|\u034F|\u061C|\u115F|\u1160|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u200B|\u200C|\u200D|\u200E|\u200F|\u202A|\u202B|\u202C|\u202D|\u202E|\u2060|\u2061|\u2062|\u2063|\u2064|\u2065|\u2066|\u2067|\u2068|\u2069|\u206A|\u206B|\u206C|\u206D|\u206E|\u206F|\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F|\uFEFF/gu;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** ioBroker adapter for synchronizing NIBE heat pump data via the local REST API. */
export class NibeRestApi extends utils.Adapter {
    private static readonly API_REQUEST_TIMEOUT_MS = 15000;
    private pollTimer: ioBroker.Timeout | undefined;
    private customPollTimer: ioBroker.Timeout | undefined;
    private pollInProgress = false;
    private customPollInProgress = false;
    private readonly writablePoints = new Map<string, WritablePointDescriptor>();
    private readonly deviceModes = new Map<string, DeviceModeDescriptor>();
    private readonly loggedUnknownPointShapes = new Set<string>();
    private readonly lastSuccessfulWrites = new Map<string, number>();
    private readonly objectDefinitionCache = new Map<string, string>();
    private readonly stateValueCache = new Map<string, CachedStateSnapshot>();
    private readonly pointStateIndex = new Map<string, string>();
    private readonly pointStateDescriptors = new Map<string, PointStateDescriptor>();
    private readonly customPollLastRun = new Map<string, number>();
    private readonly unresolvedCustomPolls = new Set<string>();

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
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("message" as never, this.onMessage.bind(this) as never);
    }

    private async onReady(): Promise<void> {
        await this.setCachedStateValue("info.connection", false, true);
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
            await this.setCachedStateValue("info.lastError", "Missing base URL", true);
            return;
        }

        if (!this.getAuthorizationHeaderValue()) {
            this.log.error("Missing authentication. Configure username/password or a Basic auth hash.");
            await this.setCachedStateValue("info.lastError", "Missing authentication", true);
            return;
        }

        this.subscribeStates("devices.*");
        this.subscribeForeignObjects(`system.adapter.${this.namespace}`);
        await this.cleanupDisabledConfiguredPoints();
        this.logLoadedCustomPollSchedules();
        await this.pollApi();
    }

    private onUnload(callback: () => void): void {
        try {
            if (this.pollTimer) {
                clearTimeout(this.pollTimer);
                this.pollTimer = undefined;
            }
            if (this.customPollTimer) {
                clearTimeout(this.customPollTimer);
                this.customPollTimer = undefined;
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
            await this.setCachedStateValue("info.lastError", message, true);
            await this.refreshSingleState(stateId);
        }
    }

    private async onObjectChange(id: string, obj: ioBroker.Object | null | undefined): Promise<void> {
        if (id !== `system.adapter.${this.namespace}` || !obj || obj.type !== "instance") {
            return;
        }

        const native = this.isRecord(obj.native) ? (obj.native as unknown as ioBroker.AdapterConfig) : undefined;
        if (!native) {
            return;
        }

        this.config = native;
        await this.cleanupStaleDeviceFolders(native);
        await this.cleanupDisabledConfiguredPoints(native);
        this.log.debug("Applied updated adapter config and cleaned up non-selected points");

        if (!this.config.baseUrl?.trim() || !this.getAuthorizationHeaderValue()) {
            this.log.debug("Skipping immediate sync after config save because connection settings are incomplete");
            return;
        }

        if (this.pollInProgress) {
            this.log.debug(
                "Config updated while polling was in progress. New points will be synced in the current or next cycle",
            );
            return;
        }

        this.log.debug("Triggering immediate sync after config save");
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        void this.pollApi();
    }

    private async onMessage(obj: MessagePayload): Promise<void> {
        if (!obj.command) {
            return;
        }

        try {
            if (obj.command === "discoverPoints") {
                this.log.debug(
                    `Received admin message discoverPoints from ${obj.from ?? "unknown"} with callback ${obj.callback ? "yes" : "no"}`,
                );
                const payload = this.isRecord(obj.message) ? obj.message : {};
                const discoveryConfig: DiscoveryRequestConfig = {
                    baseUrl: this.readString(payload.baseUrl)?.trim(),
                    username: this.readString(payload.username),
                    password: this.readString(payload.password),
                    basicAuth: this.readString(payload.basicAuth)?.trim(),
                    ignoreTlsErrors: typeof payload.ignoreTlsErrors === "boolean" ? payload.ignoreTlsErrors : undefined,
                    deviceIds: this.readString(payload.deviceIds)?.trim(),
                };
                const catalog = await this.buildDiscoveredPointCatalog(discoveryConfig);
                this.log.debug(`Discovery finished with ${catalog.length} point(s)`);
                this.sendMessageResponse(obj, catalog);
                return;
            }

            if (obj.command === "getPointOptions") {
                const payload = this.isRecord(obj.message) ? obj.message : {};
                const deviceId = this.readString(payload.deviceId)?.trim();
                const options = await this.getDiscoveredPointOptions(deviceId);
                this.sendMessageResponse(obj, options);
                return;
            }

            if (obj.command === "getKnownDevices") {
                const devices = await this.getKnownDevicesFromObjects();
                this.sendMessageResponse(obj, devices);
                return;
            }

            if (obj.command === "getIntervalProfileOptions") {
                this.log.debug(`Received admin message getIntervalProfileOptions from ${obj.from ?? "unknown"}`);
                const options = this.getIntervalProfileOptions();
                this.sendMessageResponse(obj, options);
            }
        } catch (error) {
            this.log.debug(
                `Admin message ${obj.command} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.sendMessageResponse(obj, { error: (error as Error).message });
        }
    }

    private scheduleNextPoll(): void {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }
        const intervalSeconds = Math.max(Number(this.config.pollInterval) || 1800, 10);
        this.pollTimer = this.setTimeout(() => {
            void this.pollApi();
        }, intervalSeconds * 1000);
    }

    private scheduleNextCustomPoll(): void {
        if (this.customPollTimer) {
            clearTimeout(this.customPollTimer);
        }
        this.customPollTimer = this.setTimeout(() => {
            void this.runCustomPointPolls();
        }, 1000);
    }

    private async pollApi(): Promise<void> {
        this.log.debug("pollApi started");
        if (this.pollInProgress) {
            this.log.debug("Polling still running, skipping this cycle");
            this.scheduleNextPoll();
            return;
        }

        this.pollInProgress = true;
        const pollStartedAt = Date.now();

        try {
            const devicesRequestStartedAt = Date.now();
            this.log.debug("pollApi requesting /api/v1/devices");
            const devicesResponse = await this.apiRequest<DevicesResponse>({ path: "/api/v1/devices" });
            this.log.debug("pollApi received /api/v1/devices response");
            const devicesResponseDurationMs = Date.now() - devicesRequestStartedAt;
            const devices = this.filterConfiguredDevices(devicesResponse.devices ?? []);
            this.log.debug(
                `Poll devices response in ${devicesResponseDurationMs}ms, ${devices.length} device(s) selected from ${devicesResponse.devices?.length ?? 0}`,
            );

            for (const device of devices) {
                await this.syncDevice(device);
            }

            await this.setCachedStateValue("info.connection", true, true);
            await this.setCachedStateValue("info.lastSync", new Date().toISOString(), true);
            await this.setCachedStateValue("info.lastError", "", true);
        } catch (error) {
            const message = (error as Error).message;
            this.log.error(`Polling failed: ${message}`);
            await this.setCachedStateValue("info.connection", false, true);
            await this.setCachedStateValue("info.lastError", message, true);
        } finally {
            this.log.debug(`Poll cycle finished in ${Date.now() - pollStartedAt}ms`);
            this.pollInProgress = false;
            this.scheduleNextPoll();
            this.scheduleNextCustomPoll();
        }
    }

    private async runCustomPointPolls(): Promise<void> {
        if (this.customPollInProgress || this.pollInProgress) {
            this.scheduleNextCustomPoll();
            return;
        }

        const schedules = this.getCustomPointPollSchedules();
        if (!schedules.length) {
            this.scheduleNextCustomPoll();
            return;
        }

        this.customPollInProgress = true;

        try {
            const now = Date.now();

            for (const schedule of schedules) {
                const resolvedStateIds = this.resolveCustomPollStateIds(schedule);
                if (!resolvedStateIds.length) {
                    const unresolvedKey = `${schedule.deviceId ?? "*"}:${schedule.pointId}`;
                    if (!this.unresolvedCustomPolls.has(unresolvedKey)) {
                        this.unresolvedCustomPolls.add(unresolvedKey);
                        this.log.debug(
                            `Custom point poll could not yet resolve point ${schedule.pointId} on ${schedule.deviceId ?? "all devices"}. A full poll must discover the point first.`,
                        );
                    }
                    continue;
                }

                this.unresolvedCustomPolls.delete(`${schedule.deviceId ?? "*"}:${schedule.pointId}`);

                for (const stateId of resolvedStateIds) {
                    const scheduleKey = `${stateId}:${schedule.intervalMs}`;
                    const lastRun = this.customPollLastRun.get(scheduleKey) ?? 0;
                    if (now - lastRun < schedule.intervalMs) {
                        continue;
                    }

                    this.log.debug(
                        `Custom point poll triggered for ${stateId} (point ${schedule.pointId}, device ${schedule.deviceId ?? "auto"}, interval ${Math.round(schedule.intervalMs / 1000)}s)`,
                    );
                    await this.refreshSingleState(stateId);
                    this.customPollLastRun.set(scheduleKey, Date.now());
                }
            }
        } catch (error) {
            this.log.debug(`Custom point polling failed: ${(error as Error).message}`);
        } finally {
            this.customPollInProgress = false;
            this.scheduleNextCustomPoll();
        }
    }

    private async buildDiscoveredPointCatalog(
        discoveryConfig?: DiscoveryRequestConfig,
    ): Promise<DiscoveredPointCatalogEntry[]> {
        const cachedCatalog = await this.buildDiscoveredPointCatalogFromObjects();
        if (cachedCatalog.length && !discoveryConfig?.baseUrl) {
            return cachedCatalog;
        }

        const devicesResponse = await this.apiRequest<DevicesResponse>({ path: "/api/v1/devices" }, discoveryConfig);
        const devices = this.filterConfiguredDevices(devicesResponse.devices ?? [], discoveryConfig?.deviceIds);
        const catalog: DiscoveredPointCatalogEntry[] = [];

        for (const device of devices) {
            const deviceId = device.product.serialNumber || String(device.deviceIndex);
            const deviceName = device.product.name || deviceId;
            const points = await this.apiRequest<PointsResponse>(
                {
                    path: `/api/v1/devices/${encodeURIComponent(deviceId)}/points`,
                },
                discoveryConfig,
            );

            for (const [pointKey, rawPoint] of Object.entries(points)) {
                const pointId = Number(pointKey);
                if (!Number.isFinite(pointId)) {
                    continue;
                }

                const point = this.normalizePointValue(rawPoint, pointId);
                if (!this.isValidPointValue(point)) {
                    continue;
                }

                catalog.push({
                    deviceId,
                    deviceName,
                    pointId,
                    title: point.title || `Point ${pointId}`,
                    writable: point.metadata.isWritable,
                    unit: this.normalizePointUnit(point.metadata.shortUnit || point.metadata.unit),
                    stateId: this.getPointStateBaseName(point.title),
                    currentValue: this.convertPointToStateValue(point),
                });
            }
        }

        return catalog.sort(
            (left, right) =>
                left.deviceId.localeCompare(right.deviceId) ||
                left.pointId - right.pointId ||
                left.title.localeCompare(right.title),
        );
    }

    private async buildDiscoveredPointCatalogFromObjects(): Promise<DiscoveredPointCatalogEntry[]> {
        const objects = await this.getAdapterObjectsAsync();
        const catalog: DiscoveredPointCatalogEntry[] = [];
        const productNamesByDeviceId = new Map<string, string>();

        for (const [objectId, object] of Object.entries(objects)) {
            if (object.type !== "state" || !objectId.endsWith(".product.name") || !this.isRecord(object.native)) {
                continue;
            }

            const deviceId = this.readString(object.native.deviceId)?.trim();
            if (!deviceId) {
                continue;
            }

            const stateId = objectId.startsWith(`${this.namespace}.`)
                ? objectId.slice(this.namespace.length + 1)
                : objectId;
            const state = await this.getStateAsync(stateId).catch(() => null);
            const productName = this.readString(state?.val)?.trim();
            if (productName) {
                productNamesByDeviceId.set(deviceId, productName);
            }
        }

        for (const [, object] of Object.entries(objects)) {
            if (object.type !== "state" || !this.isRecord(object.native)) {
                continue;
            }

            const pointId = Number(object.native.pointId);
            const deviceId = this.readString(object.native.deviceId)?.trim();
            if (!Number.isFinite(pointId) || !deviceId) {
                continue;
            }

            const commonName =
                typeof object.common.name === "string"
                    ? object.common.name
                    : this.isRecord(object.common.name)
                      ? this.readString(object.common.name.en) || this.readString(object.common.name.de)
                      : undefined;
            const title = this.readString(object.native.title)?.trim() || commonName || `Point ${pointId}`;
            const isWritable = object.common.write === true;
            const unit = typeof object.common.unit === "string" ? this.normalizePointUnit(object.common.unit) : "";
            const stateId = object._id.startsWith(`${this.namespace}.`)
                ? object._id.slice(this.namespace.length + 1)
                : object._id;

            catalog.push({
                deviceId,
                deviceName:
                    this.readString(object.native.deviceName)?.trim() ||
                    productNamesByDeviceId.get(deviceId) ||
                    deviceId,
                pointId,
                title,
                writable: isWritable,
                unit,
                stateId,
                currentValue: null,
            });
        }

        return catalog.sort(
            (left, right) =>
                left.deviceId.localeCompare(right.deviceId) ||
                left.pointId - right.pointId ||
                left.title.localeCompare(right.title),
        );
    }

    private async getDiscoveredPointOptions(deviceId?: string): Promise<SelectOption[]> {
        const catalog = await this.buildDiscoveredPointCatalog();
        return catalog
            .filter(entry => !deviceId || entry.deviceId === deviceId)
            .map(entry => ({
                value: entry.pointId,
                label: `${entry.pointId} - ${entry.title}${entry.unit ? ` (${entry.unit})` : ""}`,
            }));
    }

    private async getKnownDevicesFromObjects(): Promise<KnownDeviceEntry[]> {
        const objects = await this.getAdapterObjectsAsync();
        const devices = new Map<string, string>();

        for (const [objectId, object] of Object.entries(objects)) {
            if (object.type !== "state" || !objectId.endsWith(".product.name") || !this.isRecord(object.native)) {
                continue;
            }

            const deviceId = this.readString(object.native.deviceId)?.trim();
            if (!deviceId) {
                continue;
            }

            const stateId = objectId.startsWith(`${this.namespace}.`)
                ? objectId.slice(this.namespace.length + 1)
                : objectId;
            const state = await this.getStateAsync(stateId).catch(() => null);
            devices.set(deviceId, this.readString(state?.val)?.trim() || deviceId);
        }

        return Array.from(devices.entries())
            .map(([deviceId, deviceName]) => ({ deviceId, deviceName }))
            .sort(
                (left, right) =>
                    left.deviceName.localeCompare(right.deviceName) || left.deviceId.localeCompare(right.deviceId),
            );
    }

    private getIntervalProfileOptions(): SelectOption[] {
        return [
            {
                value: "",
                label: "Full poll only",
            },
            ...(this.config.customPollIntervals ?? [])
                .filter(entry => entry.id?.trim() && Number(entry.intervalSeconds) >= 5)
                .map(entry => ({
                    value: entry.id?.trim() ?? "",
                    label: `${entry.name?.trim() || entry.id?.trim()} (${Number(entry.intervalSeconds)}s)`,
                })),
        ];
    }

    private filterConfiguredDevices(devices: DeviceSummary[], deviceIdsOverride?: string): DeviceSummary[] {
        const configuredIds = (deviceIdsOverride ?? this.config.deviceIds)
            ?.split(",")
            .map(id => id.trim())
            .filter(Boolean);

        if (configuredIds?.includes(NO_ENABLED_DEVICES_MARKER)) {
            return [];
        }

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
        const deviceDisplayName = this.getDeviceDisplayName(deviceId, this.config, device.product.name || deviceId);
        const devicePath = this.getDevicePath(deviceId, this.config);
        const syncStartedAt = Date.now();

        await this.ensureDeviceObjects(devicePath, deviceId, deviceDisplayName);
        await this.syncDeviceSummary(devicePath, deviceId, device);
        await this.syncPoints(devicePath, deviceId);

        if (this.config.fetchNotifications) {
            await this.syncNotifications(devicePath, deviceId);
        }

        this.log.debug(`Poll device ${deviceId} synchronized in ${Date.now() - syncStartedAt}ms`);
    }

    private async ensureDeviceObjects(devicePath: string, deviceId: string, deviceDisplayName: string): Promise<void> {
        await this.upsertChannel(devicePath, deviceDisplayName || "Device", {
            deviceId,
            isDeviceRoot: true,
        });
        await this.upsertChannel(`${devicePath}.product`, "Product", { deviceId });
        await this.upsertChannel(`${devicePath}.points`, "Points", { deviceId });
        await this.upsertChannel(`${devicePath}.points.readOnly`, "Read-only points", { deviceId });
        await this.upsertChannel(`${devicePath}.points.writable`, "Writable points", { deviceId });
        await this.upsertChannel(`${devicePath}.notifications`, "Notifications", { deviceId });
    }

    private async upsertChannel(id: string, name: string, native: Record<string, unknown> = {}): Promise<void> {
        const channelDefinition: ioBroker.SettableObject = {
            type: "channel",
            common: { name },
            native,
        };
        await this.upsertObjectIfNeeded(id, channelDefinition);
    }

    private async syncDeviceSummary(devicePath: string, deviceId: string, device: DeviceSummary): Promise<void> {
        await this.upsertState(`${devicePath}.deviceIndex`, {
            name: "Device index",
            role: "value",
            type: "number",
            read: true,
            write: false,
            native: { deviceId },
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
            native: { deviceId },
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
            native: { deviceId },
        });
        await this.upsertState(`${devicePath}.product.serialNumber`, {
            name: "Serial number",
            role: "text",
            type: "string",
            read: true,
            write: false,
            native: { deviceId },
        });
        await this.upsertState(`${devicePath}.product.name`, {
            name: "Name",
            role: "text",
            type: "string",
            read: true,
            write: false,
            native: { deviceId },
        });
        await this.upsertState(`${devicePath}.product.manufacturer`, {
            name: "Manufacturer",
            role: "text",
            type: "string",
            read: true,
            write: false,
            native: { deviceId },
        });
        await this.upsertState(`${devicePath}.product.firmwareId`, {
            name: "Firmware ID",
            role: "text",
            type: "string",
            read: true,
            write: false,
            native: { deviceId },
        });

        this.deviceModes.set(`${devicePath}.aidMode`, { deviceId, kind: "aidMode" });
        this.deviceModes.set(`${devicePath}.smartMode`, { deviceId, kind: "smartMode" });

        await this.setCachedStateValue(`${devicePath}.deviceIndex`, device.deviceIndex, true);
        await this.setCachedStateValue(`${devicePath}.aidMode`, device.aidMode, true);
        await this.setCachedStateValue(`${devicePath}.smartMode`, device.smartMode, true);
        await this.setCachedStateValue(`${devicePath}.product.serialNumber`, device.product.serialNumber, true);
        await this.setCachedStateValue(`${devicePath}.product.name`, device.product.name, true);
        await this.setCachedStateValue(`${devicePath}.product.manufacturer`, device.product.manufacturer, true);
        await this.setCachedStateValue(`${devicePath}.product.firmwareId`, device.product.firmwareId, true);
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
        const discoveredPointKeys = new Set<string>();

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
            if (!this.isDiscoveredPointEnabled(deviceId, pointId)) {
                continue;
            }
            const pointGroupPath = point.metadata.isWritable
                ? `${devicePath}.points.writable`
                : `${devicePath}.points.readOnly`;
            const baseName = this.getPointStateBaseName(point.title);
            const countKey = `${point.metadata.isWritable ? "writable" : "readOnly"}:${baseName}`;
            const pointStateId = (pointNameCounts.get(countKey) ?? 0) > 1 ? `${baseName}_${pointId}` : baseName;
            const pointPath = `${pointGroupPath}.${pointStateId}`;
            const pointIndexKey = this.getPointIndexKey(deviceId, pointId);

            await this.upsertState(pointPath, {
                name: point.title || `Point ${pointId}`,
                role: this.determinePointRole(point.metadata),
                type: this.determineIoBrokerType(point.metadata),
                read: true,
                write: point.metadata.isWritable,
                unit: this.normalizePointUnit(point.metadata.shortUnit || point.metadata.unit) || undefined,
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

            this.pointStateIndex.set(pointIndexKey, pointPath);
            this.pointStateDescriptors.set(pointPath, { deviceId, pointId });
            discoveredPointKeys.add(pointIndexKey);

            await this.setCachedState(pointPath, {
                val: this.convertPointToStateValue(point),
                ack: true,
                q: point.datavalue.isOk ? 0 : 0x01,
            });
        }

        if (skippedPoints > 0) {
            this.log.debug(`Skipped ${skippedPoints} invalid points on device ${deviceId}`);
        }

        for (const pointIndexKey of Array.from(this.pointStateIndex.keys())) {
            if (!pointIndexKey.startsWith(`${deviceId}:`) || discoveredPointKeys.has(pointIndexKey)) {
                continue;
            }
            const stateId = this.pointStateIndex.get(pointIndexKey);
            this.pointStateIndex.delete(pointIndexKey);
            if (stateId) {
                this.pointStateDescriptors.delete(stateId);
                this.writablePoints.delete(stateId);
                this.stateValueCache.delete(stateId);
                this.objectDefinitionCache.delete(stateId);
                await this.delObjectAsync(stateId);
            }
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

        await this.setCachedStateValue(`${devicePath}.notifications.activeCount`, notifications.alarms.length, true);
        await this.setCachedStateValue(`${devicePath}.notifications.json`, JSON.stringify(notifications.alarms), true);
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
        await this.setCachedStateValue(stateId, normalizedValue, true);
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
            await this.setCachedState(stateId, {
                val: this.convertPointToStateValue(updatedPoint),
                ack: true,
                q: updatedPoint.datavalue.isOk ? 0 : 0x01,
            });
            return;
        }

        await this.refreshSingleState(stateId);
    }

    private async refreshSingleState(stateId: string): Promise<void> {
        const pointDescriptor = this.writablePoints.get(stateId) ?? this.pointStateDescriptors.get(stateId);
        if (pointDescriptor) {
            const response = await this.apiRequest<unknown>({
                path: `/api/v1/devices/${encodeURIComponent(pointDescriptor.deviceId)}/points/${pointDescriptor.pointId}`,
            });
            const point = this.extractPointValue(response, pointDescriptor.pointId);
            if (!this.isValidPointValue(point)) {
                throw new Error(`Point ${pointDescriptor.pointId} has no metadata or datavalue`);
            }
            await this.setCachedStateValue(stateId, this.convertPointToStateValue(point), true);
            return;
        }

        const deviceDescriptor = this.deviceModes.get(stateId);
        if (deviceDescriptor) {
            const device = await this.apiRequest<DeviceSummary>({
                path: `/api/v1/devices/${encodeURIComponent(deviceDescriptor.deviceId)}`,
            });
            const value = deviceDescriptor.kind === "aidMode" ? device.aidMode : device.smartMode;
            await this.setCachedStateValue(stateId, value, true);
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

    private getAuthorizationHeaderValue(discoveryConfig?: DiscoveryRequestConfig): string | undefined {
        const basicAuth = discoveryConfig?.basicAuth ?? this.config.basicAuth;
        const username = discoveryConfig?.username ?? this.config.username;
        const password = discoveryConfig?.password ?? this.config.password;

        if (basicAuth?.trim()) {
            return `Basic ${basicAuth.trim()}`;
        }

        if (!username?.trim() && !password?.trim()) {
            return undefined;
        }

        const token = Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64");
        return `Basic ${token}`;
    }

    private getAuthorizationMode(discoveryConfig?: DiscoveryRequestConfig): "basicHash" | "usernamePassword" | "none" {
        const basicAuth = discoveryConfig?.basicAuth ?? this.config.basicAuth;
        const username = discoveryConfig?.username ?? this.config.username;
        const password = discoveryConfig?.password ?? this.config.password;

        if (basicAuth?.trim()) {
            return "basicHash";
        }

        if (username?.trim() || password?.trim()) {
            return "usernamePassword";
        }

        return "none";
    }

    private formatApiErrorMessage(
        options: RequestOptions,
        requestPath: URL,
        statusCode: number | undefined,
        rawData: string,
        discoveryConfig?: DiscoveryRequestConfig,
    ): string {
        let details = statusCode != null ? `HTTP ${statusCode}` : "request failed";

        try {
            const parsed = rawData ? (JSON.parse(rawData) as ErrorResponsePayload) : undefined;
            if (parsed?.error) {
                details = parsed.error;
            }
        } catch {
            if (rawData) {
                details = rawData;
            }
        }

        const compactDetails = details.replace(/\s+/g, " ").trim();
        const tlsMode = discoveryConfig?.ignoreTlsErrors ?? this.config.ignoreTlsErrors ? "tls=ignore" : "tls=strict";
        return `${options.method ?? "GET"} ${requestPath.pathname}${requestPath.search} at ${requestPath.origin} failed: ${compactDetails} (auth=${this.getAuthorizationMode(discoveryConfig)}, ${tlsMode})`;
    }

    private async apiRequest<T>(options: RequestOptions, discoveryConfig?: DiscoveryRequestConfig): Promise<T> {
        const resolvedBaseUrl = discoveryConfig?.baseUrl?.trim() || this.config.baseUrl;
        const baseUrl = new URL(resolvedBaseUrl);
        const requestPath = new URL(options.path, `${baseUrl.origin}/`);
        const body = options.body == null ? undefined : JSON.stringify(options.body);
        const headers: Record<string, string> = {
            Accept: "application/json",
            Authorization: this.getAuthorizationHeaderValue(discoveryConfig) ?? "",
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
                        rejectUnauthorized: !(discoveryConfig?.ignoreTlsErrors ?? this.config.ignoreTlsErrors),
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
                            reject(
                                new Error(
                                    this.formatApiErrorMessage(
                                        options,
                                        requestPath,
                                        response.statusCode,
                                        rawData,
                                        discoveryConfig,
                                    ),
                                ),
                            );
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

            request.on("error", error => {
                reject(
                    new Error(
                        this.formatApiErrorMessage(
                            options,
                            requestPath,
                            undefined,
                            error instanceof Error ? error.message : String(error),
                            discoveryConfig,
                        ),
                    ),
                );
            });
            request.setTimeout(NibeRestApi.API_REQUEST_TIMEOUT_MS, () => {
                request.destroy(
                    new Error(
                        `Request timeout after ${NibeRestApi.API_REQUEST_TIMEOUT_MS}ms for ${requestPath.pathname}${requestPath.search}`,
                    ),
                );
            });

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

    private getCustomPointPollSchedules(): CustomPointPollScheduleEntry[] {
        const intervalProfiles = new Map(
            (this.config.customPollIntervals ?? [])
                .filter(entry => entry.id?.trim() && Number(entry.intervalSeconds) >= 5)
                .map(entry => [entry.id?.trim() ?? "", Number(entry.intervalSeconds) * 1000]),
        );

        return this.getConfiguredCustomPointPollEntries()
            .map(entry => ({
                enabled: entry.enabled !== false,
                deviceId: entry.deviceId?.trim() || undefined,
                pointId: Number(entry.pointId),
                intervalMs: intervalProfiles.get(entry.intervalProfileId?.trim() || "") ?? 0,
            }))
            .filter(
                entry => entry.enabled && Number.isFinite(entry.pointId) && entry.pointId > 0 && entry.intervalMs > 0,
            );
    }

    private getConfiguredCustomPointPollEntries(): ConfiguredCustomPointPollEntry[] {
        const configuredEntries = new Map<string, ConfiguredCustomPointPollEntry>();

        for (const entry of this.config.discoveredPointCatalog ?? []) {
            const deviceId = entry.deviceId?.trim();
            const pointId = Number(entry.pointId);
            const intervalProfileId = entry.intervalProfileId?.trim();

            if (!deviceId || !Number.isFinite(pointId) || pointId <= 0 || !intervalProfileId) {
                continue;
            }

            configuredEntries.set(`${deviceId}:${pointId}`, {
                enabled: entry.enabled !== false,
                deviceId,
                pointId,
                intervalProfileId,
            });
        }

        for (const entry of this.config.customPointPolls ?? []) {
            const deviceId = entry.deviceId?.trim();
            const pointId = Number(entry.pointId);
            const intervalProfileId = entry.intervalProfileId?.trim();
            const key = `${deviceId ?? "*"}:${pointId}`;

            if (!Number.isFinite(pointId) || pointId <= 0 || !intervalProfileId) {
                continue;
            }

            configuredEntries.set(key, {
                enabled: entry.enabled !== false,
                deviceId,
                pointId,
                intervalProfileId,
            });
        }

        return [...configuredEntries.values()];
    }

    private isDiscoveredPointEnabled(
        deviceId: string,
        pointId: number,
        config: ioBroker.AdapterConfig = this.config,
    ): boolean {
        const configuredPoints = (config.discoveredPointCatalog ?? []).filter(
            entry => entry.deviceId?.trim() && Number.isFinite(entry.pointId),
        );
        if (!configuredPoints.length) {
            return true;
        }

        const configuredPoint = configuredPoints.find(
            entry => entry.deviceId?.trim() === deviceId && Number(entry.pointId) === pointId,
        );
        return configuredPoint?.enabled !== false && !!configuredPoint;
    }

    private async cleanupDisabledConfiguredPoints(config: ioBroker.AdapterConfig = this.config): Promise<void> {
        const configuredPoints = (config.discoveredPointCatalog ?? []).filter(
            entry => entry.deviceId?.trim() && Number.isFinite(entry.pointId),
        );
        if (!configuredPoints.length) {
            return;
        }

        const enabledPointKeys = new Set(
            configuredPoints
                .filter(entry => entry.enabled !== false)
                .map(entry => `${entry.deviceId?.trim()}:${Number(entry.pointId)}`),
        );

        const objects = await this.getAdapterObjectsAsync();
        let removedCount = 0;

        for (const [objectId, object] of Object.entries(objects)) {
            if (object.type !== "state" || !this.isRecord(object.native)) {
                continue;
            }

            const pointId = Number(object.native.pointId);
            const deviceId = this.readString(object.native.deviceId)?.trim();
            if (!deviceId || !Number.isFinite(pointId)) {
                continue;
            }

            const pointKey = `${deviceId}:${pointId}`;
            if (enabledPointKeys.has(pointKey)) {
                continue;
            }

            const stateId = objectId.startsWith(`${this.namespace}.`)
                ? objectId.slice(this.namespace.length + 1)
                : objectId;
            this.pointStateIndex.delete(pointKey);
            this.pointStateDescriptors.delete(stateId);
            this.writablePoints.delete(stateId);
            this.stateValueCache.delete(stateId);
            this.objectDefinitionCache.delete(stateId);

            await this.delStateAsync(stateId).catch(() => undefined);
            await this.delObjectAsync(stateId).catch(() => undefined);
            removedCount++;
        }

        if (removedCount > 0) {
            this.log.debug(`Removed ${removedCount} non-selected point state(s) from objects/states`);
        }
    }

    private getConfiguredDeviceDisplayName(
        deviceId: string,
        config: ioBroker.AdapterConfig = this.config,
    ): string | undefined {
        return config.deviceDisplayNames?.find(entry => entry.deviceId?.trim() === deviceId)?.displayName?.trim();
    }

    private getCatalogDeviceDisplayName(
        deviceId: string,
        config: ioBroker.AdapterConfig = this.config,
    ): string | undefined {
        return config.discoveredPointCatalog?.find(entry => entry.deviceId?.trim() === deviceId)?.deviceName?.trim();
    }

    private getDeviceDisplayName(
        deviceId: string,
        config: ioBroker.AdapterConfig = this.config,
        fallback?: string,
    ): string {
        return (
            this.getConfiguredDeviceDisplayName(deviceId, config) ||
            this.getCatalogDeviceDisplayName(deviceId, config) ||
            fallback ||
            deviceId
        );
    }

    private getDevicePath(
        deviceId: string,
        config: ioBroker.AdapterConfig = this.config,
        fallbackDisplayName?: string,
    ): string {
        const folderBaseName = this.getDeviceDisplayName(deviceId, config, fallbackDisplayName);
        const folderSegment = this.sanitizeSegment(folderBaseName);
        return `devices.${folderSegment || this.sanitizeSegment(deviceId)}`;
    }

    private clearCachesForPrefix(prefix: string): void {
        for (const key of Array.from(this.stateValueCache.keys())) {
            if (key === prefix || key.startsWith(`${prefix}.`)) {
                this.stateValueCache.delete(key);
            }
        }
        for (const key of Array.from(this.objectDefinitionCache.keys())) {
            if (key === prefix || key.startsWith(`${prefix}.`)) {
                this.objectDefinitionCache.delete(key);
            }
        }
        for (const key of Array.from(this.pointStateDescriptors.keys())) {
            if (key === prefix || key.startsWith(`${prefix}.`)) {
                this.pointStateDescriptors.delete(key);
            }
        }
        for (const key of Array.from(this.writablePoints.keys())) {
            if (key === prefix || key.startsWith(`${prefix}.`)) {
                this.writablePoints.delete(key);
            }
        }
        for (const key of Array.from(this.deviceModes.keys())) {
            if (key === prefix || key.startsWith(`${prefix}.`)) {
                this.deviceModes.delete(key);
            }
        }
        for (const [key, value] of Array.from(this.pointStateIndex.entries())) {
            if (value === prefix || value.startsWith(`${prefix}.`)) {
                this.pointStateIndex.delete(key);
            }
        }
    }

    private async removeAdapterObjectsByPrefix(relativePrefix: string): Promise<number> {
        const fullPrefix = `${this.namespace}.${relativePrefix}`;
        const objects = await this.getAdapterObjectsAsync();
        const matchingObjectIds = Object.keys(objects)
            .filter(objectId => objectId === fullPrefix || objectId.startsWith(`${fullPrefix}.`))
            .sort((left, right) => right.length - left.length);

        if (!matchingObjectIds.length) {
            return 0;
        }

        let removedCount = 0;
        for (const objectId of matchingObjectIds) {
            const relativeId = objectId.startsWith(`${this.namespace}.`)
                ? objectId.slice(this.namespace.length + 1)
                : objectId;
            await this.delStateAsync(relativeId).catch(() => undefined);
            await this.delObjectAsync(relativeId).catch(() => undefined);
            removedCount++;
        }

        this.clearCachesForPrefix(relativePrefix);
        return removedCount;
    }

    private async cleanupStaleDeviceFolders(config: ioBroker.AdapterConfig = this.config): Promise<void> {
        const objects = await this.getAdapterObjectsAsync();
        let removedCount = 0;

        for (const [objectId, object] of Object.entries(objects)) {
            if (object.type !== "channel" || !this.isRecord(object.native) || object.native.isDeviceRoot !== true) {
                continue;
            }

            const deviceId = this.readString(object.native.deviceId)?.trim();
            if (!deviceId) {
                continue;
            }

            const expectedFullId = `${this.namespace}.${this.getDevicePath(deviceId, config)}`;
            if (objectId === expectedFullId) {
                continue;
            }

            const relativePrefix = objectId.startsWith(`${this.namespace}.`)
                ? objectId.slice(this.namespace.length + 1)
                : objectId;
            removedCount += await this.removeAdapterObjectsByPrefix(relativePrefix);
        }

        const configuredAliases = new Set(
            (config.deviceDisplayNames ?? [])
                .map(entry => entry.deviceId?.trim())
                .filter((entry): entry is string => !!entry),
        );

        for (const deviceId of configuredAliases) {
            const defaultPath = `devices.${this.sanitizeSegment(deviceId)}`;
            const expectedPath = this.getDevicePath(deviceId, config);
            if (defaultPath === expectedPath) {
                continue;
            }
            removedCount += await this.removeAdapterObjectsByPrefix(defaultPath);
        }

        if (removedCount > 0) {
            this.log.debug(`Removed ${removedCount} stale device object(s) after device rename/update`);
        }
    }

    private logLoadedCustomPollSchedules(): void {
        const schedules = this.getCustomPointPollSchedules();
        if (!schedules.length) {
            this.log.debug("Loaded 0 custom poll schedules");
            return;
        }

        const serializedSchedules = schedules
            .map(
                schedule =>
                    `${schedule.deviceId ?? "all devices"}:${schedule.pointId} -> ${Math.round(schedule.intervalMs / 1000)}s`,
            )
            .join(", ");
        this.log.debug(`Loaded ${schedules.length} custom poll schedule(s): ${serializedSchedules}`);
    }

    private resolveCustomPollStateIds(schedule: CustomPointPollScheduleEntry): string[] {
        if (schedule.deviceId) {
            const stateId = this.pointStateIndex.get(this.getPointIndexKey(schedule.deviceId, schedule.pointId));
            return stateId ? [stateId] : [];
        }

        const matches: string[] = [];
        for (const [pointIndexKey, stateId] of this.pointStateIndex.entries()) {
            if (pointIndexKey.endsWith(`:${schedule.pointId}`)) {
                matches.push(stateId);
            }
        }
        return matches;
    }

    private getPointIndexKey(deviceId: string, pointId: number): string {
        return `${deviceId}:${pointId}`;
    }

    private sendMessageResponse(obj: MessagePayload, response: unknown): void {
        if (!obj.from || !obj.command) {
            return;
        }

        this.sendTo(obj.from, obj.command, response, obj.callback);
    }

    private sanitizeSegment(value: string): string {
        return value.replace(this.FORBIDDEN_CHARS, "_");
    }

    private normalizePointUnit(unit: string | undefined | null): string {
        const normalizedUnit = String(unit || "").trim();
        if (!normalizedUnit) {
            return "";
        }
        if (normalizedUnit === "°") {
            return "°C";
        }
        return normalizedUnit;
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
        const stateDefinition: ioBroker.SettableObject = {
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
        };
        await this.upsertObjectIfNeeded(id, stateDefinition);
    }

    private async upsertObjectIfNeeded(id: string, definition: ioBroker.SettableObject): Promise<void> {
        const definitionSignature = JSON.stringify(definition);
        if (this.objectDefinitionCache.get(id) === definitionSignature) {
            return;
        }

        await this.extendObjectAsync(id, definition);
        this.objectDefinitionCache.set(id, definitionSignature);
    }

    private async setCachedStateValue(id: string, val: ioBroker.StateValue, ack: boolean): Promise<void> {
        await this.setCachedState(id, { val, ack });
    }

    private getStateUpdateMode(): "always" | "onValueChange" {
        return this.config.stateUpdateMode === "always" ? "always" : "onValueChange";
    }

    private async setCachedState(id: string, state: ioBroker.SettableState): Promise<void> {
        const normalizedState: CachedStateSnapshot = {
            val: state.val ?? null,
            ack: state.ack ?? false,
            q: state.q,
        };
        const cachedState = this.stateValueCache.get(id);
        if (
            this.getStateUpdateMode() === "onValueChange" &&
            cachedState &&
            this.areStateSnapshotsEqual(cachedState, normalizedState)
        ) {
            return;
        }

        await this.setState(id, state);
        this.stateValueCache.set(id, normalizedState);
    }

    private areStateSnapshotsEqual(left: CachedStateSnapshot, right: CachedStateSnapshot): boolean {
        return left.val === right.val && left.ack === right.ack && left.q === right.q;
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new NibeRestApi(options);
} else {
    (() => new NibeRestApi())();
}
