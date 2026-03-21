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
const NO_ENABLED_DEVICES_MARKER = "__none__";
const INVISIBLE_WORD_JOINERS = /\u00AD|\u034F|\u061C|\u115F|\u1160|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u200B|\u200C|\u200D|\u200E|\u200F|\u202A|\u202B|\u202C|\u202D|\u202E|\u2060|\u2061|\u2062|\u2063|\u2064|\u2065|\u2066|\u2067|\u2068|\u2069|\u206A|\u206B|\u206C|\u206D|\u206E|\u206F|\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F|\uFEFF/gu;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
class NibeRestApi extends utils.Adapter {
  static API_REQUEST_TIMEOUT_MS = 15e3;
  pollTimer;
  customPollTimer;
  pollInProgress = false;
  customPollInProgress = false;
  writablePoints = /* @__PURE__ */ new Map();
  deviceModes = /* @__PURE__ */ new Map();
  loggedUnknownPointShapes = /* @__PURE__ */ new Set();
  lastSuccessfulWrites = /* @__PURE__ */ new Map();
  objectDefinitionCache = /* @__PURE__ */ new Map();
  stateValueCache = /* @__PURE__ */ new Map();
  pointStateIndex = /* @__PURE__ */ new Map();
  pointStateDescriptors = /* @__PURE__ */ new Map();
  customPollLastRun = /* @__PURE__ */ new Map();
  unresolvedCustomPolls = /* @__PURE__ */ new Set();
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
    this.on("objectChange", this.onObjectChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
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
    this.subscribeForeignObjects(`system.adapter.${this.namespace}`);
    await this.cleanupDisabledConfiguredPoints();
    this.logLoadedCustomPollSchedules();
    await this.pollApi();
  }
  onUnload(callback) {
    try {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = void 0;
      }
      if (this.customPollTimer) {
        clearTimeout(this.customPollTimer);
        this.customPollTimer = void 0;
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
  async onObjectChange(id, obj) {
    var _a;
    if (id !== `system.adapter.${this.namespace}` || !obj || obj.type !== "instance") {
      return;
    }
    const native = this.isRecord(obj.native) ? obj.native : void 0;
    if (!native) {
      return;
    }
    this.config = native;
    await this.cleanupStaleDeviceFolders(native);
    await this.cleanupDisabledConfiguredPoints(native);
    this.log.debug("Applied updated adapter config and cleaned up non-selected points");
    if (!((_a = this.config.baseUrl) == null ? void 0 : _a.trim()) || !this.getAuthorizationHeaderValue()) {
      this.log.debug("Skipping immediate sync after config save because connection settings are incomplete");
      return;
    }
    if (this.pollInProgress) {
      this.log.debug("Config updated while polling was in progress. New points will be synced in the current or next cycle");
      return;
    }
    this.log.debug("Triggering immediate sync after config save");
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = void 0;
    }
    void this.pollApi();
  }
  async onMessage(obj) {
    var _a, _b, _c, _d, _e, _f;
    if (!obj.command) {
      return;
    }
    try {
      if (obj.command === "discoverPoints") {
        this.log.debug(
          `Received admin message discoverPoints from ${(_a = obj.from) != null ? _a : "unknown"} with callback ${obj.callback ? "yes" : "no"}`
        );
        const payload = this.isRecord(obj.message) ? obj.message : {};
        const discoveryConfig = {
          baseUrl: (_b = this.readString(payload.baseUrl)) == null ? void 0 : _b.trim(),
          username: this.readString(payload.username),
          password: this.readString(payload.password),
          basicAuth: (_c = this.readString(payload.basicAuth)) == null ? void 0 : _c.trim(),
          ignoreTlsErrors: typeof payload.ignoreTlsErrors === "boolean" ? payload.ignoreTlsErrors : void 0,
          deviceIds: (_d = this.readString(payload.deviceIds)) == null ? void 0 : _d.trim()
        };
        const catalog = await this.buildDiscoveredPointCatalog(discoveryConfig);
        this.log.debug(`Discovery finished with ${catalog.length} point(s)`);
        this.sendMessageResponse(obj, catalog);
        return;
      }
      if (obj.command === "getPointOptions") {
        const payload = this.isRecord(obj.message) ? obj.message : {};
        const deviceId = (_e = this.readString(payload.deviceId)) == null ? void 0 : _e.trim();
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
        this.log.debug(`Received admin message getIntervalProfileOptions from ${(_f = obj.from) != null ? _f : "unknown"}`);
        const options = this.getIntervalProfileOptions();
        this.sendMessageResponse(obj, options);
      }
    } catch (error) {
      this.log.debug(
        `Admin message ${obj.command} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      this.sendMessageResponse(obj, { error: error.message });
    }
  }
  scheduleNextPoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    const intervalSeconds = Math.max(Number(this.config.pollInterval) || 1800, 10);
    this.pollTimer = this.setTimeout(() => {
      void this.pollApi();
    }, intervalSeconds * 1e3);
  }
  scheduleNextCustomPoll() {
    if (this.customPollTimer) {
      clearTimeout(this.customPollTimer);
    }
    this.customPollTimer = this.setTimeout(() => {
      void this.runCustomPointPolls();
    }, 1e3);
  }
  async pollApi() {
    var _a, _b, _c;
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
      const devicesResponse = await this.apiRequest({ path: "/api/v1/devices" });
      this.log.debug("pollApi received /api/v1/devices response");
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
      this.scheduleNextCustomPoll();
    }
  }
  async runCustomPointPolls() {
    var _a, _b, _c, _d, _e;
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
          const unresolvedKey = `${(_a = schedule.deviceId) != null ? _a : "*"}:${schedule.pointId}`;
          if (!this.unresolvedCustomPolls.has(unresolvedKey)) {
            this.unresolvedCustomPolls.add(unresolvedKey);
            this.log.debug(
              `Custom point poll could not yet resolve point ${schedule.pointId} on ${(_b = schedule.deviceId) != null ? _b : "all devices"}. A full poll must discover the point first.`
            );
          }
          continue;
        }
        this.unresolvedCustomPolls.delete(`${(_c = schedule.deviceId) != null ? _c : "*"}:${schedule.pointId}`);
        for (const stateId of resolvedStateIds) {
          const scheduleKey = `${stateId}:${schedule.intervalMs}`;
          const lastRun = (_d = this.customPollLastRun.get(scheduleKey)) != null ? _d : 0;
          if (now - lastRun < schedule.intervalMs) {
            continue;
          }
          this.log.debug(
            `Custom point poll triggered for ${stateId} (point ${schedule.pointId}, device ${(_e = schedule.deviceId) != null ? _e : "auto"}, interval ${Math.round(schedule.intervalMs / 1e3)}s)`
          );
          await this.refreshSingleState(stateId);
          this.customPollLastRun.set(scheduleKey, Date.now());
        }
      }
    } catch (error) {
      this.log.debug(`Custom point polling failed: ${error.message}`);
    } finally {
      this.customPollInProgress = false;
      this.scheduleNextCustomPoll();
    }
  }
  async buildDiscoveredPointCatalog(discoveryConfig) {
    var _a;
    const cachedCatalog = await this.buildDiscoveredPointCatalogFromObjects();
    if (cachedCatalog.length && !(discoveryConfig == null ? void 0 : discoveryConfig.baseUrl)) {
      return cachedCatalog;
    }
    const devicesResponse = await this.apiRequest({ path: "/api/v1/devices" }, discoveryConfig);
    const devices = this.filterConfiguredDevices((_a = devicesResponse.devices) != null ? _a : [], discoveryConfig == null ? void 0 : discoveryConfig.deviceIds);
    const catalog = [];
    for (const device of devices) {
      const deviceId = device.product.serialNumber || String(device.deviceIndex);
      const deviceName = device.product.name || deviceId;
      const points = await this.apiRequest(
        {
          path: `/api/v1/devices/${encodeURIComponent(deviceId)}/points`
        },
        discoveryConfig
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
          currentValue: this.convertPointToStateValue(point)
        });
      }
    }
    return catalog.sort(
      (left, right) => left.deviceId.localeCompare(right.deviceId) || left.pointId - right.pointId || left.title.localeCompare(right.title)
    );
  }
  async buildDiscoveredPointCatalogFromObjects() {
    var _a, _b, _c, _d, _e;
    const objects = await this.getAdapterObjectsAsync();
    const catalog = [];
    const productNamesByDeviceId = /* @__PURE__ */ new Map();
    for (const [objectId, object] of Object.entries(objects)) {
      if (object.type !== "state" || !objectId.endsWith(".product.name") || !this.isRecord(object.native)) {
        continue;
      }
      const deviceId = (_a = this.readString(object.native.deviceId)) == null ? void 0 : _a.trim();
      if (!deviceId) {
        continue;
      }
      const stateId = objectId.startsWith(`${this.namespace}.`) ? objectId.slice(this.namespace.length + 1) : objectId;
      const state = await this.getStateAsync(stateId).catch(() => null);
      const productName = (_b = this.readString(state == null ? void 0 : state.val)) == null ? void 0 : _b.trim();
      if (productName) {
        productNamesByDeviceId.set(deviceId, productName);
      }
    }
    for (const [, object] of Object.entries(objects)) {
      if (object.type !== "state" || !this.isRecord(object.native)) {
        continue;
      }
      const pointId = Number(object.native.pointId);
      const deviceId = (_c = this.readString(object.native.deviceId)) == null ? void 0 : _c.trim();
      if (!Number.isFinite(pointId) || !deviceId) {
        continue;
      }
      const commonName = typeof object.common.name === "string" ? object.common.name : this.isRecord(object.common.name) ? this.readString(object.common.name.en) || this.readString(object.common.name.de) : void 0;
      const title = ((_d = this.readString(object.native.title)) == null ? void 0 : _d.trim()) || commonName || `Point ${pointId}`;
      const isWritable = object.common.write === true;
      const unit = typeof object.common.unit === "string" ? this.normalizePointUnit(object.common.unit) : "";
      const stateId = object._id.startsWith(`${this.namespace}.`) ? object._id.slice(this.namespace.length + 1) : object._id;
      catalog.push({
        deviceId,
        deviceName: ((_e = this.readString(object.native.deviceName)) == null ? void 0 : _e.trim()) || productNamesByDeviceId.get(deviceId) || deviceId,
        pointId,
        title,
        writable: isWritable,
        unit,
        stateId,
        currentValue: null
      });
    }
    return catalog.sort(
      (left, right) => left.deviceId.localeCompare(right.deviceId) || left.pointId - right.pointId || left.title.localeCompare(right.title)
    );
  }
  async getDiscoveredPointOptions(deviceId) {
    const catalog = await this.buildDiscoveredPointCatalog();
    return catalog.filter((entry) => !deviceId || entry.deviceId === deviceId).map((entry) => ({
      value: entry.pointId,
      label: `${entry.pointId} - ${entry.title}${entry.unit ? ` (${entry.unit})` : ""}`
    }));
  }
  async getKnownDevicesFromObjects() {
    var _a, _b;
    const objects = await this.getAdapterObjectsAsync();
    const devices = /* @__PURE__ */ new Map();
    for (const [objectId, object] of Object.entries(objects)) {
      if (object.type !== "state" || !objectId.endsWith(".product.name") || !this.isRecord(object.native)) {
        continue;
      }
      const deviceId = (_a = this.readString(object.native.deviceId)) == null ? void 0 : _a.trim();
      if (!deviceId) {
        continue;
      }
      const stateId = objectId.startsWith(`${this.namespace}.`) ? objectId.slice(this.namespace.length + 1) : objectId;
      const state = await this.getStateAsync(stateId).catch(() => null);
      devices.set(deviceId, ((_b = this.readString(state == null ? void 0 : state.val)) == null ? void 0 : _b.trim()) || deviceId);
    }
    return Array.from(devices.entries()).map(([deviceId, deviceName]) => ({ deviceId, deviceName })).sort((left, right) => left.deviceName.localeCompare(right.deviceName) || left.deviceId.localeCompare(right.deviceId));
  }
  getIntervalProfileOptions() {
    var _a;
    return [
      {
        value: "",
        label: "Full poll only"
      },
      ...((_a = this.config.customPollIntervals) != null ? _a : []).filter((entry) => {
        var _a2;
        return ((_a2 = entry.id) == null ? void 0 : _a2.trim()) && Number(entry.intervalSeconds) >= 5;
      }).map((entry) => {
        var _a2, _b, _c, _d;
        return {
          value: (_b = (_a2 = entry.id) == null ? void 0 : _a2.trim()) != null ? _b : "",
          label: `${((_c = entry.name) == null ? void 0 : _c.trim()) || ((_d = entry.id) == null ? void 0 : _d.trim())} (${Number(entry.intervalSeconds)}s)`
        };
      })
    ];
  }
  filterConfiguredDevices(devices, deviceIdsOverride) {
    var _a;
    const configuredIds = (_a = deviceIdsOverride != null ? deviceIdsOverride : this.config.deviceIds) == null ? void 0 : _a.split(",").map((id) => id.trim()).filter(Boolean);
    if (configuredIds == null ? void 0 : configuredIds.includes(NO_ENABLED_DEVICES_MARKER)) {
      return [];
    }
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
  async ensureDeviceObjects(devicePath, deviceId, deviceDisplayName) {
    await this.upsertChannel(devicePath, deviceDisplayName || "Device", {
      deviceId,
      isDeviceRoot: true
    });
    await this.upsertChannel(`${devicePath}.product`, "Product", { deviceId });
    await this.upsertChannel(`${devicePath}.points`, "Points", { deviceId });
    await this.upsertChannel(`${devicePath}.points.readOnly`, "Read-only points", { deviceId });
    await this.upsertChannel(`${devicePath}.points.writable`, "Writable points", { deviceId });
    await this.upsertChannel(`${devicePath}.notifications`, "Notifications", { deviceId });
  }
  async upsertChannel(id, name, native = {}) {
    const channelDefinition = {
      type: "channel",
      common: { name },
      native
    };
    await this.upsertObjectIfNeeded(id, channelDefinition);
  }
  async syncDeviceSummary(devicePath, deviceId, device) {
    await this.upsertState(`${devicePath}.deviceIndex`, {
      name: "Device index",
      role: "value",
      type: "number",
      read: true,
      write: false,
      native: { deviceId }
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
      },
      native: { deviceId }
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
      },
      native: { deviceId }
    });
    await this.upsertState(`${devicePath}.product.serialNumber`, {
      name: "Serial number",
      role: "text",
      type: "string",
      read: true,
      write: false,
      native: { deviceId }
    });
    await this.upsertState(`${devicePath}.product.name`, {
      name: "Name",
      role: "text",
      type: "string",
      read: true,
      write: false,
      native: { deviceId }
    });
    await this.upsertState(`${devicePath}.product.manufacturer`, {
      name: "Manufacturer",
      role: "text",
      type: "string",
      read: true,
      write: false,
      native: { deviceId }
    });
    await this.upsertState(`${devicePath}.product.firmwareId`, {
      name: "Firmware ID",
      role: "text",
      type: "string",
      read: true,
      write: false,
      native: { deviceId }
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
    const discoveredPointKeys = /* @__PURE__ */ new Set();
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
      if (!this.isDiscoveredPointEnabled(deviceId, pointId)) {
        continue;
      }
      const pointGroupPath = point.metadata.isWritable ? `${devicePath}.points.writable` : `${devicePath}.points.readOnly`;
      const baseName = this.getPointStateBaseName(point.title);
      const countKey = `${point.metadata.isWritable ? "writable" : "readOnly"}:${baseName}`;
      const pointStateId = ((_b = pointNameCounts.get(countKey)) != null ? _b : 0) > 1 ? `${baseName}_${pointId}` : baseName;
      const pointPath = `${pointGroupPath}.${pointStateId}`;
      const pointIndexKey = this.getPointIndexKey(deviceId, pointId);
      await this.upsertState(pointPath, {
        name: point.title || `Point ${pointId}`,
        role: this.determinePointRole(point.metadata),
        type: this.determineIoBrokerType(point.metadata),
        read: true,
        write: point.metadata.isWritable,
        unit: this.normalizePointUnit(point.metadata.shortUnit || point.metadata.unit) || void 0,
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
      this.pointStateIndex.set(pointIndexKey, pointPath);
      this.pointStateDescriptors.set(pointPath, { deviceId, pointId });
      discoveredPointKeys.add(pointIndexKey);
      await this.setCachedState(pointPath, {
        val: this.convertPointToStateValue(point),
        ack: true,
        q: point.datavalue.isOk ? 0 : 1
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
    var _a;
    const pointDescriptor = (_a = this.writablePoints.get(stateId)) != null ? _a : this.pointStateDescriptors.get(stateId);
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
  getAuthorizationHeaderValue(discoveryConfig) {
    var _a, _b, _c;
    const basicAuth = (_a = discoveryConfig == null ? void 0 : discoveryConfig.basicAuth) != null ? _a : this.config.basicAuth;
    const username = (_b = discoveryConfig == null ? void 0 : discoveryConfig.username) != null ? _b : this.config.username;
    const password = (_c = discoveryConfig == null ? void 0 : discoveryConfig.password) != null ? _c : this.config.password;
    if (basicAuth == null ? void 0 : basicAuth.trim()) {
      return `Basic ${basicAuth.trim()}`;
    }
    if (!(username == null ? void 0 : username.trim()) && !(password == null ? void 0 : password.trim())) {
      return void 0;
    }
    const token = import_node_buffer.Buffer.from(`${username != null ? username : ""}:${password != null ? password : ""}`).toString("base64");
    return `Basic ${token}`;
  }
  async apiRequest(options, discoveryConfig) {
    var _a, _b;
    const resolvedBaseUrl = ((_a = discoveryConfig == null ? void 0 : discoveryConfig.baseUrl) == null ? void 0 : _a.trim()) || this.config.baseUrl;
    const baseUrl = new URL(resolvedBaseUrl);
    const requestPath = new URL(options.path, `${baseUrl.origin}/`);
    const body = options.body == null ? void 0 : JSON.stringify(options.body);
    const headers = {
      Accept: "application/json",
      Authorization: (_b = this.getAuthorizationHeaderValue(discoveryConfig)) != null ? _b : ""
    };
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = import_node_buffer.Buffer.byteLength(body).toString();
    }
    return await new Promise((resolve, reject) => {
      var _a2, _b2;
      const request = https.request(
        {
          protocol: requestPath.protocol,
          hostname: requestPath.hostname,
          port: requestPath.port,
          path: `${requestPath.pathname}${requestPath.search}`,
          method: (_a2 = options.method) != null ? _a2 : "GET",
          headers,
          agent: new https.Agent({
            rejectUnauthorized: !((_b2 = discoveryConfig == null ? void 0 : discoveryConfig.ignoreTlsErrors) != null ? _b2 : this.config.ignoreTlsErrors)
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
      request.setTimeout(NibeRestApi.API_REQUEST_TIMEOUT_MS, () => {
        request.destroy(
          new Error(
            `Request timeout after ${NibeRestApi.API_REQUEST_TIMEOUT_MS}ms for ${requestPath.pathname}${requestPath.search}`
          )
        );
      });
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
  getCustomPointPollSchedules() {
    var _a;
    const intervalProfiles = new Map(
      ((_a = this.config.customPollIntervals) != null ? _a : []).filter((entry) => {
        var _a2;
        return ((_a2 = entry.id) == null ? void 0 : _a2.trim()) && Number(entry.intervalSeconds) >= 5;
      }).map((entry) => {
        var _a2, _b;
        return [(_b = (_a2 = entry.id) == null ? void 0 : _a2.trim()) != null ? _b : "", Number(entry.intervalSeconds) * 1e3];
      })
    );
    return this.getConfiguredCustomPointPollEntries().map((entry) => {
      var _a2, _b, _c;
      return {
        enabled: entry.enabled !== false,
        deviceId: ((_a2 = entry.deviceId) == null ? void 0 : _a2.trim()) || void 0,
        pointId: Number(entry.pointId),
        intervalMs: (_c = intervalProfiles.get(((_b = entry.intervalProfileId) == null ? void 0 : _b.trim()) || "")) != null ? _c : 0
      };
    }).filter(
      (entry) => entry.enabled && Number.isFinite(entry.pointId) && entry.pointId > 0 && entry.intervalMs > 0
    );
  }
  getConfiguredCustomPointPollEntries() {
    var _a, _b, _c, _d, _e, _f;
    const configuredEntries = /* @__PURE__ */ new Map();
    for (const entry of (_a = this.config.discoveredPointCatalog) != null ? _a : []) {
      const deviceId = (_b = entry.deviceId) == null ? void 0 : _b.trim();
      const pointId = Number(entry.pointId);
      const intervalProfileId = (_c = entry.intervalProfileId) == null ? void 0 : _c.trim();
      if (!deviceId || !Number.isFinite(pointId) || pointId <= 0 || !intervalProfileId) {
        continue;
      }
      configuredEntries.set(`${deviceId}:${pointId}`, {
        enabled: entry.enabled !== false,
        deviceId,
        pointId,
        intervalProfileId
      });
    }
    for (const entry of (_d = this.config.customPointPolls) != null ? _d : []) {
      const deviceId = (_e = entry.deviceId) == null ? void 0 : _e.trim();
      const pointId = Number(entry.pointId);
      const intervalProfileId = (_f = entry.intervalProfileId) == null ? void 0 : _f.trim();
      const key = `${deviceId != null ? deviceId : "*"}:${pointId}`;
      if (!Number.isFinite(pointId) || pointId <= 0 || !intervalProfileId) {
        continue;
      }
      configuredEntries.set(key, {
        enabled: entry.enabled !== false,
        deviceId,
        pointId,
        intervalProfileId
      });
    }
    return [...configuredEntries.values()];
  }
  isDiscoveredPointEnabled(deviceId, pointId, config = this.config) {
    var _a;
    const configuredPoints = ((_a = config.discoveredPointCatalog) != null ? _a : []).filter(
      (entry) => {
        var _a2;
        return ((_a2 = entry.deviceId) == null ? void 0 : _a2.trim()) && Number.isFinite(entry.pointId);
      }
    );
    if (!configuredPoints.length) {
      return true;
    }
    const configuredPoint = configuredPoints.find(
      (entry) => {
        var _a2;
        return ((_a2 = entry.deviceId) == null ? void 0 : _a2.trim()) === deviceId && Number(entry.pointId) === pointId;
      }
    );
    return (configuredPoint == null ? void 0 : configuredPoint.enabled) !== false && !!configuredPoint;
  }
  async cleanupDisabledConfiguredPoints(config = this.config) {
    var _a, _b;
    const configuredPoints = ((_a = config.discoveredPointCatalog) != null ? _a : []).filter(
      (entry) => {
        var _a2;
        return ((_a2 = entry.deviceId) == null ? void 0 : _a2.trim()) && Number.isFinite(entry.pointId);
      }
    );
    if (!configuredPoints.length) {
      return;
    }
    const enabledPointKeys = new Set(
      configuredPoints.filter((entry) => entry.enabled !== false).map((entry) => {
        var _a2;
        return `${(_a2 = entry.deviceId) == null ? void 0 : _a2.trim()}:${Number(entry.pointId)}`;
      })
    );
    const objects = await this.getAdapterObjectsAsync();
    let removedCount = 0;
    for (const [objectId, object] of Object.entries(objects)) {
      if (object.type !== "state" || !this.isRecord(object.native)) {
        continue;
      }
      const pointId = Number(object.native.pointId);
      const deviceId = (_b = this.readString(object.native.deviceId)) == null ? void 0 : _b.trim();
      if (!deviceId || !Number.isFinite(pointId)) {
        continue;
      }
      const pointKey = `${deviceId}:${pointId}`;
      if (enabledPointKeys.has(pointKey)) {
        continue;
      }
      const stateId = objectId.startsWith(`${this.namespace}.`) ? objectId.slice(this.namespace.length + 1) : objectId;
      this.pointStateIndex.delete(pointKey);
      this.pointStateDescriptors.delete(stateId);
      this.writablePoints.delete(stateId);
      this.stateValueCache.delete(stateId);
      this.objectDefinitionCache.delete(stateId);
      await this.delStateAsync(stateId).catch(() => void 0);
      await this.delObjectAsync(stateId).catch(() => void 0);
      removedCount++;
    }
    if (removedCount > 0) {
      this.log.debug(`Removed ${removedCount} non-selected point state(s) from objects/states`);
    }
  }
  getConfiguredDeviceDisplayName(deviceId, config = this.config) {
    var _a, _b, _c;
    return (_c = (_b = (_a = config.deviceDisplayNames) == null ? void 0 : _a.find((entry) => {
      var _a2;
      return ((_a2 = entry.deviceId) == null ? void 0 : _a2.trim()) === deviceId;
    })) == null ? void 0 : _b.displayName) == null ? void 0 : _c.trim();
  }
  getCatalogDeviceDisplayName(deviceId, config = this.config) {
    var _a, _b, _c;
    return (_c = (_b = (_a = config.discoveredPointCatalog) == null ? void 0 : _a.find((entry) => {
      var _a2;
      return ((_a2 = entry.deviceId) == null ? void 0 : _a2.trim()) === deviceId;
    })) == null ? void 0 : _b.deviceName) == null ? void 0 : _c.trim();
  }
  getDeviceDisplayName(deviceId, config = this.config, fallback) {
    return this.getConfiguredDeviceDisplayName(deviceId, config) || this.getCatalogDeviceDisplayName(deviceId, config) || fallback || deviceId;
  }
  getDevicePath(deviceId, config = this.config, fallbackDisplayName) {
    const folderBaseName = this.getDeviceDisplayName(deviceId, config, fallbackDisplayName);
    const folderSegment = this.sanitizeSegment(folderBaseName);
    return `devices.${folderSegment || this.sanitizeSegment(deviceId)}`;
  }
  clearCachesForPrefix(prefix) {
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
  async removeAdapterObjectsByPrefix(relativePrefix) {
    const fullPrefix = `${this.namespace}.${relativePrefix}`;
    const objects = await this.getAdapterObjectsAsync();
    const matchingObjectIds = Object.keys(objects).filter((objectId) => objectId === fullPrefix || objectId.startsWith(`${fullPrefix}.`)).sort((left, right) => right.length - left.length);
    if (!matchingObjectIds.length) {
      return 0;
    }
    let removedCount = 0;
    for (const objectId of matchingObjectIds) {
      const relativeId = objectId.startsWith(`${this.namespace}.`) ? objectId.slice(this.namespace.length + 1) : objectId;
      await this.delStateAsync(relativeId).catch(() => void 0);
      await this.delObjectAsync(relativeId).catch(() => void 0);
      removedCount++;
    }
    this.clearCachesForPrefix(relativePrefix);
    return removedCount;
  }
  async cleanupStaleDeviceFolders(config = this.config) {
    var _a, _b;
    const objects = await this.getAdapterObjectsAsync();
    let removedCount = 0;
    for (const [objectId, object] of Object.entries(objects)) {
      if (object.type !== "channel" || !this.isRecord(object.native) || object.native.isDeviceRoot !== true) {
        continue;
      }
      const deviceId = (_a = this.readString(object.native.deviceId)) == null ? void 0 : _a.trim();
      if (!deviceId) {
        continue;
      }
      const expectedFullId = `${this.namespace}.${this.getDevicePath(deviceId, config)}`;
      if (objectId === expectedFullId) {
        continue;
      }
      const relativePrefix = objectId.startsWith(`${this.namespace}.`) ? objectId.slice(this.namespace.length + 1) : objectId;
      removedCount += await this.removeAdapterObjectsByPrefix(relativePrefix);
    }
    const configuredAliases = new Set(
      ((_b = config.deviceDisplayNames) != null ? _b : []).map((entry) => {
        var _a2;
        return (_a2 = entry.deviceId) == null ? void 0 : _a2.trim();
      }).filter((entry) => !!entry)
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
  logLoadedCustomPollSchedules() {
    const schedules = this.getCustomPointPollSchedules();
    if (!schedules.length) {
      this.log.debug("Loaded 0 custom poll schedules");
      return;
    }
    const serializedSchedules = schedules.map(
      (schedule) => {
        var _a;
        return `${(_a = schedule.deviceId) != null ? _a : "all devices"}:${schedule.pointId} -> ${Math.round(schedule.intervalMs / 1e3)}s`;
      }
    ).join(", ");
    this.log.debug(`Loaded ${schedules.length} custom poll schedule(s): ${serializedSchedules}`);
  }
  resolveCustomPollStateIds(schedule) {
    if (schedule.deviceId) {
      const stateId = this.pointStateIndex.get(this.getPointIndexKey(schedule.deviceId, schedule.pointId));
      return stateId ? [stateId] : [];
    }
    const matches = [];
    for (const [pointIndexKey, stateId] of this.pointStateIndex.entries()) {
      if (pointIndexKey.endsWith(`:${schedule.pointId}`)) {
        matches.push(stateId);
      }
    }
    return matches;
  }
  getPointIndexKey(deviceId, pointId) {
    return `${deviceId}:${pointId}`;
  }
  sendMessageResponse(obj, response) {
    if (!obj.from || !obj.command) {
      return;
    }
    this.sendTo(obj.from, obj.command, response, obj.callback);
  }
  sanitizeSegment(value) {
    return value.replace(this.FORBIDDEN_CHARS, "_");
  }
  normalizePointUnit(unit) {
    const normalizedUnit = String(unit || "").trim();
    if (!normalizedUnit) {
      return "";
    }
    if (normalizedUnit === "\xB0") {
      return "\xB0C";
    }
    return normalizedUnit;
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
  getStateUpdateMode() {
    return this.config.stateUpdateMode === "always" ? "always" : "onValueChange";
  }
  async setCachedState(id, state) {
    var _a, _b;
    const normalizedState = {
      val: (_a = state.val) != null ? _a : null,
      ack: (_b = state.ack) != null ? _b : false,
      q: state.q
    };
    const cachedState = this.stateValueCache.get(id);
    if (this.getStateUpdateMode() === "onValueChange" && cachedState && this.areStateSnapshotsEqual(cachedState, normalizedState)) {
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
