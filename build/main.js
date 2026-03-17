"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  NibeRestApi: () => NibeRestApi
});
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_node_buffer = require("node:buffer");
var https = __toESM(require("node:https"));
const INVISIBLE_WORD_JOINERS = /\u00AD|\u034F|\u061C|\u115F|\u1160|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u200B|\u200C|\u200D|\u200E|\u200F|\u202A|\u202B|\u202C|\u202D|\u202E|\u2060|\u2061|\u2062|\u2063|\u2064|\u2065|\u2066|\u2067|\u2068|\u2069|\u206A|\u206B|\u206C|\u206D|\u206E|\u206F|\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F|\uFEFF/gu;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
class NibeRestApi extends utils.Adapter {
  pollTimer;
  pollInProgress = false;
  writablePoints = /* @__PURE__ */ new Map();
  deviceModes = /* @__PURE__ */ new Map();
  loggedUnknownPointShapes = /* @__PURE__ */ new Set();
  lastSuccessfulWrites = /* @__PURE__ */ new Map();
  objectDefinitionCache = /* @__PURE__ */ new Map();
  stateValueCache = /* @__PURE__ */ new Map();
  /**
   * Creates the adapter instance with the standard ioBroker lifecycle handlers.
   *
   * @param options Adapter options supplied by ioBroker during startup or tests.
   */
  constructor(options = {}) {
    super({
      ...options,
      name: "nibe-rest-api"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a;
    await this.setCachedStateValue("info.connection", false, true);
    await this.setObjectNotExistsAsync("info.lastSync", {
      type: "state",
      common: {
        name: "Last successful synchronization",
        type: "string",
        role: "value.time",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.lastError", {
      type: "state",
      common: {
        name: "Last error message",
        type: "string",
        role: "text",
        read: true,
        write: false
      },
      native: {}
    });
    if (!((_a = this.config.baseUrl) == null ? void 0 : _a.trim())) {
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
    await this.pollApi();
  }
  onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = void 0;
      }
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
  async onStateChange(id, state) {
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
      const message = error.message;
      this.log.error(`Failed to process write for ${stateId}: ${message}`);
      await this.setCachedStateValue("info.lastError", message, true);
      await this.refreshSingleState(stateId);
    }
  }
  scheduleNextPoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    const intervalSeconds = Math.max(Number(this.config.pollInterval) || 30, 5);
    this.pollTimer = this.setTimeout(() => {
      void this.pollApi();
    }, intervalSeconds * 1e3);
  }
  async pollApi() {
    var _a, _b, _c;
    if (this.pollInProgress) {
      this.log.debug("Polling still running, skipping this cycle");
      this.scheduleNextPoll();
      return;
    }
    this.pollInProgress = true;
    const pollStartedAt = Date.now();
    try {
      const devicesRequestStartedAt = Date.now();
      const devicesResponse = await this.apiRequest({ path: "/api/v1/devices" });
      const devicesResponseDurationMs = Date.now() - devicesRequestStartedAt;
      const devices = this.filterConfiguredDevices((_a = devicesResponse.devices) != null ? _a : []);
      this.log.debug(
        `Poll devices response in ${devicesResponseDurationMs}ms, ${devices.length} device(s) selected from ${(_c = (_b = devicesResponse.devices) == null ? void 0 : _b.length) != null ? _c : 0}`
      );
      for (const device of devices) {
        await this.syncDevice(device);
      }
      await this.setCachedStateValue("info.connection", true, true);
      await this.setCachedStateValue("info.lastSync", (/* @__PURE__ */ new Date()).toISOString(), true);
      await this.setCachedStateValue("info.lastError", "", true);
    } catch (error) {
      const message = error.message;
      this.log.error(`Polling failed: ${message}`);
      await this.setCachedStateValue("info.connection", false, true);
      await this.setCachedStateValue("info.lastError", message, true);
    } finally {
      this.log.debug(`Poll cycle finished in ${Date.now() - pollStartedAt}ms`);
      this.pollInProgress = false;
      this.scheduleNextPoll();
    }
  }
  filterConfiguredDevices(devices) {
    var _a;
    const configuredIds = (_a = this.config.deviceIds) == null ? void 0 : _a.split(",").map((id) => id.trim()).filter(Boolean);
    if (!(configuredIds == null ? void 0 : configuredIds.length)) {
      return devices;
    }
    const configuredSet = new Set(configuredIds);
    return devices.filter(
      (device) => configuredSet.has(String(device.deviceIndex)) || configuredSet.has(device.product.serialNumber)
    );
  }
  async syncDevice(device) {
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
  async ensureDeviceObjects(devicePath) {
    await this.upsertChannel(devicePath, "Device");
    await this.upsertChannel(`${devicePath}.product`, "Product");
    await this.upsertChannel(`${devicePath}.points`, "Points");
    await this.upsertChannel(`${devicePath}.points.readOnly`, "Read-only points");
    await this.upsertChannel(`${devicePath}.points.writable`, "Writable points");
    await this.upsertChannel(`${devicePath}.notifications`, "Notifications");
  }
  async upsertChannel(id, name) {
    const channelDefinition = {
      type: "channel",
      common: { name },
      native: {}
    };
    await this.upsertObjectIfNeeded(id, channelDefinition);
  }
  async syncDeviceSummary(devicePath, deviceId, device) {
    await this.upsertState(`${devicePath}.deviceIndex`, {
      name: "Device index",
      role: "value",
      type: "number",
      read: true,
      write: false
    });
    await this.upsertState(`${devicePath}.aidMode`, {
      name: "Aid mode",
      role: "state",
      type: "string",
      read: true,
      write: true,
      states: {
        off: "off",
        on: "on"
      }
    });
    await this.upsertState(`${devicePath}.smartMode`, {
      name: "Smart mode",
      role: "state",
      type: "string",
      read: true,
      write: true,
      states: {
        normal: "normal",
        away: "away"
      }
    });
    await this.upsertState(`${devicePath}.product.serialNumber`, {
      name: "Serial number",
      role: "text",
      type: "string",
      read: true,
      write: false
    });
    await this.upsertState(`${devicePath}.product.name`, {
      name: "Name",
      role: "text",
      type: "string",
      read: true,
      write: false
    });
    await this.upsertState(`${devicePath}.product.manufacturer`, {
      name: "Manufacturer",
      role: "text",
      type: "string",
      read: true,
      write: false
    });
    await this.upsertState(`${devicePath}.product.firmwareId`, {
      name: "Firmware ID",
      role: "text",
      type: "string",
      read: true,
      write: false
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
  async syncPoints(devicePath, deviceId) {
    var _a, _b;
    const pointsRequestStartedAt = Date.now();
    const points = await this.apiRequest({
      path: `/api/v1/devices/${encodeURIComponent(deviceId)}/points`
    });
    const pointsResponseDurationMs = Date.now() - pointsRequestStartedAt;
    const pointsPreparationStartedAt = Date.now();
    let skippedPoints = 0;
    const normalizedPoints = [];
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
    const pointNameCounts = /* @__PURE__ */ new Map();
    for (const { point } of normalizedPoints) {
      const pointGroup = point.metadata.isWritable ? "writable" : "readOnly";
      const baseName = this.getPointStateBaseName(point.title);
      const countKey = `${pointGroup}:${baseName}`;
      pointNameCounts.set(countKey, ((_a = pointNameCounts.get(countKey)) != null ? _a : 0) + 1);
    }
    for (const { pointId, point } of normalizedPoints) {
      const pointGroupPath = point.metadata.isWritable ? `${devicePath}.points.writable` : `${devicePath}.points.readOnly`;
      const baseName = this.getPointStateBaseName(point.title);
      const countKey = `${point.metadata.isWritable ? "writable" : "readOnly"}:${baseName}`;
      const pointStateId = ((_b = pointNameCounts.get(countKey)) != null ? _b : 0) > 1 ? `${baseName}_${pointId}` : baseName;
      const pointPath = `${pointGroupPath}.${pointStateId}`;
      await this.upsertState(pointPath, {
        name: point.title || `Point ${pointId}`,
        role: this.determinePointRole(point.metadata),
        type: this.determineIoBrokerType(point.metadata),
        read: true,
        write: point.metadata.isWritable,
        unit: point.metadata.shortUnit || point.metadata.unit || void 0,
        desc: this.buildPointDescription(point.description, pointId),
        native: {
          pointId,
          deviceId,
          title: point.title,
          isWritable: point.metadata.isWritable,
          variableId: point.metadata.variableId
        }
      });
      if (point.metadata.isWritable) {
        this.writablePoints.set(pointPath, {
          deviceId,
          pointId,
          metadata: point.metadata
        });
      } else {
        this.writablePoints.delete(pointPath);
      }
      await this.setCachedState(pointPath, {
        val: this.convertPointToStateValue(point),
        ack: true,
        q: point.datavalue.isOk ? 0 : 1
      });
    }
    if (skippedPoints > 0) {
      this.log.debug(`Skipped ${skippedPoints} invalid points on device ${deviceId}`);
    }
    this.log.debug(
      `Poll points for device ${deviceId}: response ${pointsResponseDurationMs}ms, preparation ${Date.now() - pointsPreparationStartedAt}ms, ${normalizedPoints.length} point(s)`
    );
  }
  async syncNotifications(devicePath, deviceId) {
    const notificationsRequestStartedAt = Date.now();
    const notifications = await this.apiRequest({
      path: `/api/v1/devices/${encodeURIComponent(deviceId)}/notifications`
    });
    const notificationsResponseDurationMs = Date.now() - notificationsRequestStartedAt;
    const notificationsPreparationStartedAt = Date.now();
    await this.upsertState(`${devicePath}.notifications.activeCount`, {
      name: "Active notifications",
      role: "value",
      type: "number",
      read: true,
      write: false
    });
    await this.upsertState(`${devicePath}.notifications.json`, {
      name: "Notifications JSON",
      role: "json",
      type: "string",
      read: true,
      write: false
    });
    await this.setCachedStateValue(`${devicePath}.notifications.activeCount`, notifications.alarms.length, true);
    await this.setCachedStateValue(`${devicePath}.notifications.json`, JSON.stringify(notifications.alarms), true);
    this.log.debug(
      `Poll notifications for device ${deviceId}: response ${notificationsResponseDurationMs}ms, preparation ${Date.now() - notificationsPreparationStartedAt}ms, ${notifications.alarms.length} alarm(s)`
    );
  }
  async handleModeWrite(stateId, value) {
    const descriptor = this.deviceModes.get(stateId);
    if (!descriptor) {
      return;
    }
    const normalizedValue = String(value);
    const path = descriptor.kind === "aidMode" ? `/api/v1/devices/${encodeURIComponent(descriptor.deviceId)}/aidmode` : `/api/v1/devices/${encodeURIComponent(descriptor.deviceId)}/smartmode`;
    const body = descriptor.kind === "aidMode" ? { aidMode: normalizedValue } : { smartMode: normalizedValue };
    this.log.debug(`Writing mode ${stateId} via ${path} with payload: ${this.formatUnknownForLog(body)}`);
    const response = await this.apiRequest({ method: "POST", path, body });
    this.log.debug(`Write response for mode ${stateId}: ${this.formatUnknownForLog(response)}`);
    await this.setCachedStateValue(stateId, normalizedValue, true);
    await this.pollApi();
  }
  async handlePointWrite(stateId, value) {
    const descriptor = this.writablePoints.get(stateId);
    if (!descriptor) {
      return;
    }
    const payload = {
      type: "datavalue",
      isOk: true,
      variableId: descriptor.pointId
    };
    if (descriptor.metadata.variableType === "binary") {
      payload.integerValue = value ? 1 : 0;
    } else if (this.isStringLikeType(descriptor.metadata.variableType)) {
      payload.stringValue = value == null ? "" : String(value);
    } else {
      payload.integerValue = this.scalePointWriteValue(value, descriptor.metadata);
    }
    this.log.debug(
      `Writing point ${stateId} (${descriptor.pointId}) with payload: ${this.formatUnknownForLog(payload)}`
    );
    const result = await this.apiRequest({
      method: "PATCH",
      path: `/api/v1/devices/${encodeURIComponent(descriptor.deviceId)}/points`,
      body: [payload]
    });
    this.log.debug(
      `Write response for point ${stateId} (${descriptor.pointId}): ${this.formatUnknownForLog(result)}`
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
        q: updatedPoint.datavalue.isOk ? 0 : 1
      });
      return;
    }
    await this.refreshSingleState(stateId);
  }
  async refreshSingleState(stateId) {
    const pointDescriptor = this.writablePoints.get(stateId);
    if (pointDescriptor) {
      const response = await this.apiRequest({
        path: `/api/v1/devices/${encodeURIComponent(pointDescriptor.deviceId)}/points/${pointDescriptor.pointId}`
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
      const device = await this.apiRequest({
        path: `/api/v1/devices/${encodeURIComponent(deviceDescriptor.deviceId)}`
      });
      const value = deviceDescriptor.kind === "aidMode" ? device.aidMode : device.smartMode;
      await this.setCachedStateValue(stateId, value, true);
    }
  }
  convertPointToStateValue(point) {
    var _a;
    const { metadata, datavalue } = point;
    if (!datavalue) {
      return null;
    }
    if (metadata.variableType === "binary") {
      return Boolean(datavalue.integerValue);
    }
    if (this.isStringLikeType(metadata.variableType)) {
      return (_a = datavalue.stringValue) != null ? _a : "";
    }
    if (typeof datavalue.integerValue === "number") {
      return this.scalePointReadValue(datavalue.integerValue, metadata);
    }
    if (typeof datavalue.stringValue === "string") {
      return datavalue.stringValue;
    }
    return null;
  }
  determineIoBrokerType(metadata) {
    if (metadata.variableType === "binary") {
      return "boolean";
    }
    if (this.isStringLikeType(metadata.variableType)) {
      return "string";
    }
    return "number";
  }
  determinePointRole(metadata) {
    if (metadata.variableType === "binary") {
      return metadata.isWritable ? "switch" : "indicator";
    }
    if (metadata.variableType === "string" || metadata.variableType === "date" || metadata.variableType === "time") {
      return "text";
    }
    if (metadata.shortUnit === "\xB0C" || metadata.unit === "\xB0C") {
      return "value.temperature";
    }
    return "value";
  }
  scalePointReadValue(integerValue, metadata) {
    const divisor = metadata.divisor || 1;
    return integerValue / divisor;
  }
  scalePointWriteValue(value, metadata) {
    const numericValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      throw new Error(`Invalid numeric value: ${value}`);
    }
    const divisor = metadata.divisor || 1;
    return Math.round(numericValue * divisor);
  }
  isStringLikeType(variableType) {
    return variableType === "string" || variableType === "time" || variableType === "date" || variableType === "unknown";
  }
  ensureWriteLockElapsed(stateId) {
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
    const remainingSeconds = Math.ceil((lockIntervalMs - elapsedMs) / 1e3);
    throw new Error(`Write lock active for ${stateId}. Try again in ${remainingSeconds}s`);
  }
  getWriteLockIntervalMs() {
    const lockIntervalSeconds = Math.max(Number(this.config.writeLockInterval) || 120, 0);
    return lockIntervalSeconds * 1e3;
  }
  getAuthorizationHeaderValue() {
    var _a, _b, _c, _d, _e;
    if ((_a = this.config.basicAuth) == null ? void 0 : _a.trim()) {
      return `Basic ${this.config.basicAuth.trim()}`;
    }
    if (!((_b = this.config.username) == null ? void 0 : _b.trim()) && !((_c = this.config.password) == null ? void 0 : _c.trim())) {
      return void 0;
    }
    const token = import_node_buffer.Buffer.from(`${(_d = this.config.username) != null ? _d : ""}:${(_e = this.config.password) != null ? _e : ""}`).toString("base64");
    return `Basic ${token}`;
  }
  async apiRequest(options) {
    var _a;
    const baseUrl = new URL(this.config.baseUrl);
    const requestPath = new URL(options.path, `${baseUrl.origin}/`);
    const body = options.body == null ? void 0 : JSON.stringify(options.body);
    const headers = {
      Accept: "application/json",
      Authorization: (_a = this.getAuthorizationHeaderValue()) != null ? _a : ""
    };
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = import_node_buffer.Buffer.byteLength(body).toString();
    }
    return await new Promise((resolve, reject) => {
      var _a2;
      const request = https.request(
        {
          protocol: requestPath.protocol,
          hostname: requestPath.hostname,
          port: requestPath.port,
          path: `${requestPath.pathname}${requestPath.search}`,
          method: (_a2 = options.method) != null ? _a2 : "GET",
          headers,
          agent: new https.Agent({
            rejectUnauthorized: !this.config.ignoreTlsErrors
          })
        },
        (response) => {
          let rawData = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            rawData += chunk;
          });
          response.on("end", () => {
            var _a3;
            const statusCode = (_a3 = response.statusCode) != null ? _a3 : 500;
            if (statusCode < 200 || statusCode >= 300) {
              let message = `HTTP ${statusCode}`;
              try {
                const parsed = rawData ? JSON.parse(rawData) : void 0;
                if (parsed == null ? void 0 : parsed.error) {
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
              resolve(void 0);
              return;
            }
            try {
              resolve(JSON.parse(rawData));
            } catch {
              resolve(rawData);
            }
          });
        }
      );
      request.on("error", reject);
      if (body) {
        request.write(body);
      }
      request.end();
    });
  }
  extractPointValue(response, pointId) {
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
  isValidPointValue(point) {
    return !!(point == null ? void 0 : point.metadata) && !!point.datavalue;
  }
  normalizePointValue(rawPoint, pointId) {
    var _a, _b;
    const candidates = this.collectPointCandidates(rawPoint, pointId);
    for (const candidate of candidates) {
      const metadata = this.extractMetadata(candidate);
      const datavalue = this.extractDataValue(candidate);
      if (!metadata || !datavalue) {
        continue;
      }
      return {
        title: (_a = this.readString(candidate.title)) != null ? _a : `Point ${pointId}`,
        description: (_b = this.readString(candidate.description)) != null ? _b : "",
        metadata,
        datavalue
      };
    }
    return void 0;
  }
  collectPointCandidates(rawPoint, pointId) {
    if (!this.isRecord(rawPoint)) {
      return [];
    }
    const candidates = [rawPoint];
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
  extractMetadata(candidate) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o;
    const metadataCandidate = this.isRecord(candidate.metadata) ? candidate.metadata : candidate;
    if (!this.readString(metadataCandidate.variableType)) {
      return void 0;
    }
    return {
      type: "metadata",
      variableId: (_a = this.readNumber(metadataCandidate.variableId)) != null ? _a : 0,
      variableType: (_b = this.readString(metadataCandidate.variableType)) != null ? _b : "unknown",
      variableSize: (_c = this.readString(metadataCandidate.variableSize)) != null ? _c : "",
      unit: (_d = this.readString(metadataCandidate.unit)) != null ? _d : "",
      modbusRegisterType: (_e = this.readString(metadataCandidate.modbusRegisterType)) != null ? _e : "",
      shortUnit: (_f = this.readString(metadataCandidate.shortUnit)) != null ? _f : "",
      isWritable: (_g = this.readBoolean(metadataCandidate.isWritable)) != null ? _g : false,
      divisor: (_h = this.readNumber(metadataCandidate.divisor)) != null ? _h : 1,
      decimal: (_i = this.readNumber(metadataCandidate.decimal)) != null ? _i : 0,
      modbusRegisterID: (_j = this.readNumber(metadataCandidate.modbusRegisterID)) != null ? _j : 0,
      minValue: (_k = this.readNumber(metadataCandidate.minValue)) != null ? _k : 0,
      maxValue: (_l = this.readNumber(metadataCandidate.maxValue)) != null ? _l : 0,
      intDefaultValue: (_m = this.readNumber(metadataCandidate.intDefaultValue)) != null ? _m : 0,
      change: (_n = this.readNumber(metadataCandidate.change)) != null ? _n : 0,
      stringDefaultValue: (_o = this.readString(metadataCandidate.stringDefaultValue)) != null ? _o : ""
    };
  }
  extractDataValue(candidate) {
    var _a, _b;
    const explicitDataValue = this.isRecord(candidate.datavalue) ? candidate.datavalue : this.isRecord(candidate.dataValue) ? candidate.dataValue : this.isRecord(candidate.value) ? candidate.value : void 0;
    const dataValueCandidate = explicitDataValue || (typeof candidate.integerValue === "number" || typeof candidate.stringValue === "string" ? candidate : void 0);
    if (!dataValueCandidate) {
      return void 0;
    }
    const integerValue = this.readNumber(dataValueCandidate.integerValue);
    const stringValue = this.readString(dataValueCandidate.stringValue);
    if (integerValue === void 0 && stringValue === void 0) {
      return void 0;
    }
    return {
      type: "datavalue",
      isOk: (_a = this.readBoolean(dataValueCandidate.isOk)) != null ? _a : false,
      variableId: (_b = this.readNumber(dataValueCandidate.variableId)) != null ? _b : 0,
      integerValue,
      stringValue
    };
  }
  logUnknownPointShapeOnce(deviceId, pointId, rawPoint) {
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
      `Skipping point ${pointId} on device ${deviceId} because metadata or datavalue is missing. Raw sample: ${serialized.slice(0, 300)}`
    );
  }
  isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  readString(value) {
    return typeof value === "string" ? value : void 0;
  }
  readNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  readBoolean(value) {
    return typeof value === "boolean" ? value : void 0;
  }
  getPointStateBaseName(title) {
    const sanitizedTitle = this.normalizeTitleForStateId(title).replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    return sanitizedTitle || "point";
  }
  normalizeTitleForStateId(title) {
    return title.normalize("NFKD").replace(INVISIBLE_WORD_JOINERS, "").replace(COMBINING_MARKS, "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  }
  buildPointDescription(description, pointId) {
    const trimmedDescription = description.trim();
    return trimmedDescription ? `${trimmedDescription}
Point ID: ${pointId}` : `Point ID: ${pointId}`;
  }
  sanitizeSegment(value) {
    return value.replace(this.FORBIDDEN_CHARS, "_");
  }
  formatApiResultValue(value) {
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
  formatUnknownForLog(value) {
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
  isAcceptedPointWriteResult(value, pointId) {
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
  extractWritablePointFromWriteResult(value, pointId) {
    if (!this.isRecord(value)) {
      return void 0;
    }
    const point = this.normalizePointValue(value, pointId);
    return this.isValidPointValue(point) ? point : void 0;
  }
  async upsertState(id, common) {
    var _a, _b, _c, _d, _e, _f;
    const stateDefinition = {
      type: "state",
      common: {
        name: (_a = common.name) != null ? _a : id,
        type: (_b = common.type) != null ? _b : "string",
        role: (_c = common.role) != null ? _c : "state",
        read: (_d = common.read) != null ? _d : true,
        write: (_e = common.write) != null ? _e : false,
        unit: common.unit,
        desc: common.desc,
        min: common.min,
        max: common.max,
        states: common.states
      },
      native: (_f = common.native) != null ? _f : {}
    };
    await this.upsertObjectIfNeeded(id, stateDefinition);
  }
  async upsertObjectIfNeeded(id, definition) {
    const definitionSignature = JSON.stringify(definition);
    if (this.objectDefinitionCache.get(id) === definitionSignature) {
      return;
    }
    await this.extendObjectAsync(id, definition);
    this.objectDefinitionCache.set(id, definitionSignature);
  }
  async setCachedStateValue(id, val, ack) {
    await this.setCachedState(id, { val, ack });
  }
  async setCachedState(id, state) {
    var _a, _b;
    const normalizedState = {
      val: (_a = state.val) != null ? _a : null,
      ack: (_b = state.ack) != null ? _b : false,
      q: state.q
    };
    const cachedState = this.stateValueCache.get(id);
    if (cachedState && this.areStateSnapshotsEqual(cachedState, normalizedState)) {
      return;
    }
    await this.setState(id, state);
    this.stateValueCache.set(id, normalizedState);
  }
  areStateSnapshotsEqual(left, right) {
    return left.val === right.val && left.ack === right.ack && left.q === right.q;
  }
}
if (require.main !== module) {
  module.exports = (options) => new NibeRestApi(options);
} else {
  (() => new NibeRestApi())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  NibeRestApi
});
//# sourceMappingURL=main.js.map
