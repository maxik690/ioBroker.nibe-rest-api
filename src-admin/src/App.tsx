import React from "react";
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Chip,
    CssBaseline,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    FormLabel,
    IconButton,
    InputAdornment,
    MenuItem,
    Pagination,
    Paper,
    Radio,
    RadioGroup,
    Select,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    ThemeProvider,
    Typography,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import { GenericApp, I18n, Loader, type GenericAppProps, type GenericAppState } from "@iobroker/adapter-react-v5";

import en from "../../admin/i18n/en.json";
import de from "../../admin/i18n/de.json";
import es from "../../admin/i18n/es.json";
import fr from "../../admin/i18n/fr.json";
import it from "../../admin/i18n/it.json";
import nl from "../../admin/i18n/nl.json";
import pl from "../../admin/i18n/pl.json";
import pt from "../../admin/i18n/pt.json";
import ru from "../../admin/i18n/ru.json";
import uk from "../../admin/i18n/uk.json";
import zhCn from "../../admin/i18n/zh-cn.json";
import logoUrl from "../../admin/nibe-rest-api-wide.png";

const COMPLETE_POLL_FILTER_VALUE = "__complete_poll__";
const DEFAULT_DISCOVERY_ROWS_PER_PAGE = 20;
const DISCOVERY_ROWS_PER_PAGE_OPTIONS = [10, 20, 50, 100, 200];
const DELETE_PROFILE_TARGET_UNSELECTED = "__select_profile__";
const NO_ENABLED_DEVICES_MARKER = "__none__";

type IntervalProfile = ioBroker.CustomPollIntervalConfig;
type DiscoveredPoint = ioBroker.DiscoveredPointConfig;
type DeviceDisplayName = ioBroker.DeviceDisplayNameConfig;
type AdapterConfig = ioBroker.AdapterConfig;
type KnownDevice = { deviceId: string; deviceName: string; enabled: boolean };

interface AppState extends GenericAppState {
    discoveryLoading: boolean;
    discoveryStatus: string;
    discoveryUiReady: boolean;
    search: string;
    searchDebounced: string;
    deviceIdFilter: string;
    enabledFilter: string;
    writableFilter: string;
    intervalFilter: string;
    discoveryPage: number;
    discoveryRowsPerPage: number;
    knownDevices: KnownDevice[];
    deleteDialogOpen: boolean;
    deleteProfileIndex: number | null;
    deleteTargetIntervalProfileId: string;
}

interface BaseUrlParts {
    protocol: string;
    host: string;
    port: string;
}

interface IntervalProfileRowProps {
    profile: IntervalProfile;
    onChange: (patch: Partial<IntervalProfile>) => void;
    onDelete: () => void;
}

function parseBaseUrl(baseUrl?: string): BaseUrlParts {
    const fallback: BaseUrlParts = {
        protocol: "https",
        host: "",
        port: "8443",
    };

    if (!baseUrl) {
        return fallback;
    }

    try {
        const url = new URL(baseUrl);
        return {
            protocol: (url.protocol || "https:").replace(":", ""),
            host: url.hostname || "",
            port: url.port || (url.protocol === "http:" ? "80" : "8443"),
        };
    } catch {
        const match = String(baseUrl).match(/^(https?):\/\/([^/:]+)(?::(\d+))?/i);
        if (!match) {
            return fallback;
        }
        return {
            protocol: (match[1] || "https").toLowerCase(),
            host: match[2] || "",
            port: match[3] || (match[1]?.toLowerCase() === "http" ? "80" : "8443"),
        };
    }
}

function composeBaseUrl(parts: BaseUrlParts): string {
    const protocol = String(parts.protocol || "https").replace(/:$/, "");
    const host = String(parts.host || "").trim();
    const port = String(parts.port || "").trim();

    if (!host) {
        return "";
    }

    return `${protocol}://${host}${port ? `:${port}` : ""}/`;
}

function formatCurrentValue(value: unknown): string {
    if (value === null || typeof value === "undefined" || value === "") {
        return "";
    }
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch {
            return "[unserializable object]";
        }
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    return "";
}

function normalizeUniqueDeviceDisplayNames(rows?: DeviceDisplayName[]): DeviceDisplayName[] {
    const usedNames = new Set<string>();
    return (rows || [])
        .map(entry => ({
            deviceId: String(entry.deviceId || "").trim(),
            displayName: String(entry.displayName || "").trim(),
        }))
        .filter(entry => entry.deviceId && entry.displayName)
        .map(entry => {
            let candidate = entry.displayName;
            let suffix = 1;
            while (usedNames.has(candidate)) {
                candidate = `${entry.displayName}_${suffix++}`;
            }
            usedNames.add(candidate);
            return {
                deviceId: entry.deviceId,
                displayName: candidate,
            };
        });
}

function normalizeIntervalProfiles(rows?: IntervalProfile[]): IntervalProfile[] {
    const profiles = Array.isArray(rows) ? rows.map(row => ({ ...row })) : [];
    const seenIds = new Set<string>();
    let nextId = 1;

    return profiles
        .filter(row => row && String(row.id || "").trim() !== "full")
        .map(row => {
            let id = String(row.id || "").trim();
            while (!id || seenIds.has(id)) {
                id = String(nextId++);
            }
            seenIds.add(id);
            return {
                id,
                name: row.name || "",
                intervalSeconds: Number(row.intervalSeconds) || 0,
            };
        });
}

function getPointKey(point: Pick<DiscoveredPoint, "deviceId" | "pointId">): string {
    return `${String(point.deviceId || "")}:${Number(point.pointId || 0)}`;
}

function IntervalProfileRow(props: IntervalProfileRowProps): React.JSX.Element {
    const { profile, onChange, onDelete } = props;
    const [name, setName] = React.useState(profile.name || "");
    const [intervalSeconds, setIntervalSeconds] = React.useState(String(profile.intervalSeconds ?? 60));

    React.useEffect(() => {
        setName(profile.name || "");
        setIntervalSeconds(String(profile.intervalSeconds ?? 60));
    }, [profile.id, profile.name, profile.intervalSeconds]);

    React.useEffect(() => {
        const timeout = window.setTimeout(() => {
            const parsedValue = Number(intervalSeconds);
            onChange({
                name,
                intervalSeconds: Number.isFinite(parsedValue) ? parsedValue : 0,
            });
        }, 200);

        return () => window.clearTimeout(timeout);
    }, [name, intervalSeconds, onChange]);

    return (
        <TableRow hover>
            <TableCell sx={{ width: "45%" }}>
                <TextField
                    fullWidth
                    size="small"
                    value={name}
                    onChange={event => setName(event.target.value)}
                />
            </TableCell>
            <TableCell sx={{ width: 180 }}>
                <TextField
                    fullWidth
                    size="small"
                    type="number"
                    inputProps={{ min: 5 }}
                    value={intervalSeconds}
                    onChange={event => setIntervalSeconds(event.target.value)}
                />
            </TableCell>
            <TableCell sx={{ width: 90 }}>
                <IconButton
                    color="error"
                    onClick={onDelete}
                >
                    <DeleteIcon />
                </IconButton>
            </TableCell>
        </TableRow>
    );
}

export default class App extends GenericApp<GenericAppProps, AppState> {
    private searchDebounceTimer: ReturnType<typeof window.setTimeout> | null = null;

    public constructor(props: GenericAppProps) {
        const socketPort = parseInt(window.location.port, 10) || 8081;
        super(props, {
            ...props,
            adapterName: "nibe-rest-api",
            encryptedFields: ["password"],
            doNotLoadAllObjects: true,
            doNotLoadACL: true,
            translations: {
                en,
                de,
                es,
                fr,
                it,
                nl,
                pl,
                pt,
                ru,
                uk,
                "zh-cn": zhCn,
            },
            socket: {
                port: socketPort === 3000 ? 8081 : socketPort,
            },
        });

        this.state = {
            ...this.state,
            discoveryLoading: false,
            discoveryStatus: "",
            discoveryUiReady: false,
            search: "",
            searchDebounced: "",
            deviceIdFilter: "",
            enabledFilter: "",
            writableFilter: "",
            intervalFilter: "",
            discoveryPage: 0,
            discoveryRowsPerPage: DEFAULT_DISCOVERY_ROWS_PER_PAGE,
            knownDevices: [],
            deleteDialogOpen: false,
            deleteProfileIndex: null,
            deleteTargetIntervalProfileId: "",
        };
    }

    private normalizeLoadedNative(native: Record<string, unknown>): AdapterConfig {
        const settings = native as AdapterConfig;
        const rawPollInterval = Number(settings.pollInterval);
        const rawWriteLockInterval = Number(settings.writeLockInterval);
        const deviceDisplayNames = (settings.deviceDisplayNames || [])
            .map(entry => ({
                deviceId: String(entry.deviceId || "").trim(),
                displayName: String(entry.displayName || ""),
            }))
            .filter(entry => entry.deviceId);
        const configuredDeviceNames = new Map(
            deviceDisplayNames.map(entry => [entry.deviceId, entry.displayName.trim()]).filter(([, value]) => !!value),
        );
        const customPollAssignments = new Map<string, string>();
        (settings.customPointPolls || []).forEach(entry => {
            if (entry?.enabled === false || !entry?.intervalProfileId) {
                return;
            }
            customPollAssignments.set(
                `${String(entry.deviceId || "")}:${Number(entry.pointId || 0)}`,
                String(entry.intervalProfileId || ""),
            );
        });

        const discoveredPointCatalog = (settings.discoveredPointCatalog || []).map(entry => ({
            enabled: entry.enabled !== false,
            deviceId: entry.deviceId || "",
            deviceName: entry.deviceName || entry.deviceId || "",
            pointId: Number(entry.pointId) || 0,
            title: entry.title || "",
            writable: !!entry.writable,
            unit: entry.unit || "",
            stateId: entry.stateId || "",
            currentValue: entry.currentValue ?? null,
            intervalProfileId: entry.intervalProfileId || customPollAssignments.get(getPointKey(entry)) || "",
        }));

        return {
            baseUrl: settings.baseUrl || "",
            username: settings.username || "",
            password: settings.password || "",
            basicAuth: settings.basicAuth || "",
            pollInterval: Number.isFinite(rawPollInterval) && rawPollInterval > 0 ? rawPollInterval : 1800,
            writeLockInterval:
                Number.isFinite(rawWriteLockInterval) && rawWriteLockInterval >= 0 ? rawWriteLockInterval : 120,
            stateUpdateMode: settings.stateUpdateMode === "always" ? "always" : "onValueChange",
            discoveredPointCatalog,
            customPollIntervals: normalizeIntervalProfiles(settings.customPollIntervals),
            customPointPolls: [],
            deviceDisplayNames,
            deviceIds: settings.deviceIds || "",
            ignoreTlsErrors: settings.ignoreTlsErrors !== false,
            fetchNotifications: settings.fetchNotifications !== false,
        };
    }

    private prepareNativeForSave(native: Record<string, unknown>): AdapterConfig {
        const settings = this.normalizeLoadedNative(native);
        const customPollIntervals = normalizeIntervalProfiles(settings.customPollIntervals).filter(
            row => row.id && (row.name || Number(row.intervalSeconds)),
        );
        const discoveredPointCatalog = (settings.discoveredPointCatalog || []).map(entry => ({
            enabled: entry.enabled !== false,
            deviceId: entry.deviceId || "",
            deviceName: entry.deviceName || entry.deviceId || "",
            pointId: Number(entry.pointId) || 0,
            title: entry.title || "",
            writable: !!entry.writable,
            unit: entry.unit || "",
            stateId: entry.stateId || "",
            currentValue: entry.currentValue ?? null,
            intervalProfileId: entry.intervalProfileId || "",
        }));
        const knownDevices = this.getKnownDevices();
        const enabledDeviceIds = knownDevices.filter(device => device.enabled).map(device => device.deviceId);
        const deviceIds =
            !knownDevices.length
                ? ""
                : enabledDeviceIds.length === knownDevices.length
                  ? ""
                  : enabledDeviceIds.length
                    ? enabledDeviceIds.join(",")
                    : NO_ENABLED_DEVICES_MARKER;

        return {
            ...settings,
            pollInterval: Math.max(Number(settings.pollInterval) || 1800, 10),
            writeLockInterval: Math.max(Number(settings.writeLockInterval) || 0, 0),
            discoveredPointCatalog,
            customPollIntervals,
            deviceDisplayNames: normalizeUniqueDeviceDisplayNames(settings.deviceDisplayNames),
            deviceIds,
            customPointPolls: discoveredPointCatalog
                .filter(entry => entry.enabled !== false && !!entry.intervalProfileId)
                .map(entry => ({
                    enabled: true,
                    deviceId: entry.deviceId || "",
                    pointId: Number(entry.pointId) || 0,
                    intervalProfileId: entry.intervalProfileId || "",
                })),
        };
    }

    public override onPrepareLoad(settings: Record<string, unknown>, encryptedNative?: string[]): void {
        super.onPrepareLoad(settings, encryptedNative);
        const normalized = this.normalizeLoadedNative(settings);
        Object.keys(settings).forEach(key => delete settings[key]);
        Object.assign(settings, normalized);
    }

    public override onPrepareSave(settings: Record<string, unknown>): boolean {
        const prepared = this.prepareNativeForSave(settings);
        Object.keys(settings).forEach(key => delete settings[key]);
        Object.assign(settings, prepared);
        return true;
    }

    public override onLoadConfig(newNative: Record<string, unknown>): void {
        this.onPrepareLoad(newNative, ["password"]);
        super.onLoadConfig(newNative);
    }

    public override componentWillUnmount(): void {
        if (this.searchDebounceTimer) {
            window.clearTimeout(this.searchDebounceTimer);
            this.searchDebounceTimer = null;
        }
        super.componentWillUnmount();
    }

    public override componentDidUpdate(prevProps: Readonly<GenericAppProps>, prevState: Readonly<AppState>): void {
        super.componentDidUpdate?.(prevProps, prevState);

        if (this.state.loaded && !prevState.loaded && !this.state.discoveryUiReady) {
            window.setTimeout(() => {
                if (this.state.loaded && !this.state.discoveryUiReady) {
                    this.setState({ discoveryUiReady: true });
                }
            }, 0);
            void this.loadKnownDevices();
        }
    }

    private async loadKnownDevices(): Promise<void> {
        try {
            const response = await this.socket.sendTo<KnownDevice[] | { error?: string }>(this.instanceId, "getKnownDevices", {});
            if (Array.isArray(response)) {
                const rawDeviceIds = this.getNative().deviceIds
                    .split(",")
                    .map(id => id.trim())
                    .filter(Boolean);
                const noDeviceEnabled = rawDeviceIds.includes(NO_ENABLED_DEVICES_MARKER);
                const configuredIds = new Set(
                    rawDeviceIds.filter(id => id !== NO_ENABLED_DEVICES_MARKER),
                );
                this.setState({
                    knownDevices: response.map(device => ({
                        ...device,
                        enabled: noDeviceEnabled ? false : configuredIds.size === 0 ? true : configuredIds.has(device.deviceId),
                    })),
                });
            }
        } catch {
            // best effort for labels only
        }
    }

    private getNative(): AdapterConfig {
        return this.normalizeLoadedNative(this.state.native);
    }

    private getBaseUrlParts(): BaseUrlParts {
        return parseBaseUrl(this.getNative().baseUrl);
    }

    private updateBaseUrlPart(part: keyof BaseUrlParts, value: string): void {
        const parts = this.getBaseUrlParts();
        parts[part] = value;
        this.updateNativeValue("baseUrl", composeBaseUrl(parts));
    }

    private updateNativeField<K extends keyof AdapterConfig>(field: K, value: AdapterConfig[K]): void {
        this.updateNativeValue(String(field), value);
    }

    private updateDiscoveredPointCatalog(catalog: DiscoveredPoint[]): void {
        this.updateNativeValue("discoveredPointCatalog", catalog);
    }

    private updateCustomPollIntervals(rows: IntervalProfile[]): void {
        this.updateNativeValue("customPollIntervals", normalizeIntervalProfiles(rows));
    }

    private getKnownDevices(): Array<{ deviceId: string; deviceName: string; configuredDisplayName: string }> {
        const native = this.getNative();
        const configuredIds = native.deviceIds
            .split(",")
            .map(id => id.trim())
            .filter(Boolean);
        const noDeviceEnabled = configuredIds.includes(NO_ENABLED_DEVICES_MARKER);
        const configuredIdSet = new Set(configuredIds.filter(id => id !== NO_ENABLED_DEVICES_MARKER));
        const configuredNames = new Map(
            (native.deviceDisplayNames || []).map(entry => [
                String(entry.deviceId || "").trim(),
                String(entry.displayName || ""),
            ]),
        );
        const discoveredNames = new Map(
            (native.discoveredPointCatalog || []).map(entry => [
                String(entry.deviceId || "").trim(),
                String(entry.deviceName || entry.deviceId || ""),
            ]),
        );
        const objectNames = new Map(
            this.state.knownDevices.map(entry => [
                String(entry.deviceId || "").trim(),
                entry,
            ]),
        );
        const allDeviceIds = new Set<string>([
            ...Array.from(configuredNames.keys()).filter(Boolean),
            ...Array.from(configuredIdSet.values()).filter(Boolean),
            ...Array.from(objectNames.keys()).filter(Boolean),
            ...Array.from(discoveredNames.keys()).filter(Boolean),
        ]);

        return Array.from(allDeviceIds)
            .map(deviceId => ({
                deviceId,
                deviceName: objectNames.get(deviceId)?.deviceName?.trim() || discoveredNames.get(deviceId)?.trim() || deviceId,
                configuredDisplayName: configuredNames.get(deviceId)?.trim() || "",
                enabled:
                    objectNames.get(deviceId)?.enabled ??
                    (noDeviceEnabled ? false : configuredIdSet.size === 0 ? true : configuredIdSet.has(deviceId)),
            }))
            .sort((left, right) => left.deviceName.localeCompare(right.deviceName) || left.deviceId.localeCompare(right.deviceId));
    }

    private updateKnownDeviceEnabled(deviceId: string, enabled: boolean): void {
        const nextKnownDevices = this.getKnownDevices().map(device => ({
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            enabled: device.deviceId === deviceId ? enabled : device.enabled,
        }));
        const enabledDeviceIds = nextKnownDevices.filter(device => device.enabled).map(device => device.deviceId);
        const deviceIds =
            !nextKnownDevices.length
                ? ""
                : enabledDeviceIds.length === nextKnownDevices.length
                  ? ""
                  : enabledDeviceIds.length
                    ? enabledDeviceIds.join(",")
                    : NO_ENABLED_DEVICES_MARKER;

        this.setState({ knownDevices: nextKnownDevices });
        this.updateNativeValue("deviceIds", deviceIds);
    }

    private updateDeviceDisplayName(deviceId: string, displayName: string): void {
        const native = this.getNative();
        const trimmedDeviceId = String(deviceId || "").trim();
        const trimmedDisplayName = String(displayName || "");
        const nextMappings = new Map(
            (native.deviceDisplayNames || []).map(entry => [String(entry.deviceId || "").trim(), String(entry.displayName || "")]),
        );

        if (!trimmedDisplayName.trim()) {
            nextMappings.delete(trimmedDeviceId);
        } else {
            nextMappings.set(trimmedDeviceId, trimmedDisplayName);
        }

        this.updateNativeValue(
            "deviceDisplayNames",
            Array.from(nextMappings.entries()).map(([mappedDeviceId, mappedDisplayName]) => ({
                deviceId: mappedDeviceId,
                displayName: mappedDisplayName,
            })),
        );
    }

    private getIntervalProfileOptions(): Array<{ value: string; label: string }> {
        const native = this.getNative();
        return [
            {
                value: "",
                label: `${I18n.t("Complete poll interval")} (${Number(native.pollInterval || 1800)}s)`,
            },
            ...(native.customPollIntervals || []).map(entry => ({
                value: String(entry.id || ""),
                label: `${entry.name || entry.id} (${Number(entry.intervalSeconds || 0)}s)`,
            })),
        ];
    }

    private getFilteredDiscoveredEntries(): DiscoveredPoint[] {
        const native = this.getNative();
        const search = this.state.searchDebounced.trim().toLowerCase();

        return (native.discoveredPointCatalog || []).filter(entry => {
            if (this.state.deviceIdFilter && String(entry.deviceId || "") !== this.state.deviceIdFilter) {
                return false;
            }
            if (this.state.enabledFilter === "yes" && entry.enabled === false) {
                return false;
            }
            if (this.state.enabledFilter === "no" && entry.enabled !== false) {
                return false;
            }
            if (this.state.writableFilter === "yes" && !entry.writable) {
                return false;
            }
            if (this.state.writableFilter === "no" && entry.writable) {
                return false;
            }
            if (this.state.intervalFilter === COMPLETE_POLL_FILTER_VALUE && entry.intervalProfileId) {
                return false;
            }
            if (
                this.state.intervalFilter &&
                this.state.intervalFilter !== COMPLETE_POLL_FILTER_VALUE &&
                String(entry.intervalProfileId || "") !== this.state.intervalFilter
            ) {
                return false;
            }
            if (!search) {
                return true;
            }

            return [entry.deviceName, entry.deviceId, entry.pointId, entry.title, entry.unit, formatCurrentValue(entry.currentValue)]
                .filter(Boolean)
                .join(" ")
                .toLowerCase()
                .includes(search);
        });
    }

    private updatePoint(point: DiscoveredPoint, updater: (entry: DiscoveredPoint) => DiscoveredPoint): void {
        const native = this.getNative();
        const catalog = (native.discoveredPointCatalog || []).map(entry =>
            getPointKey(entry) === getPointKey(point) ? updater({ ...entry }) : entry,
        );
        this.updateDiscoveredPointCatalog(catalog);
    }

    private setAllFilteredPointsEnabled(enabled: boolean): void {
        const filteredKeys = new Set(this.getFilteredDiscoveredEntries().map(entry => getPointKey(entry)));
        const native = this.getNative();
        const catalog = (native.discoveredPointCatalog || []).map(entry => {
            if (!filteredKeys.has(getPointKey(entry))) {
                return entry;
            }
            return {
                ...entry,
                enabled,
                intervalProfileId: enabled ? entry.intervalProfileId || "" : "",
            };
        });
        this.updateDiscoveredPointCatalog(catalog);
    }

    private addIntervalProfile(): void {
        const native = this.getNative();
        const maxId = (native.customPollIntervals || []).reduce((max, entry) => {
            const numericId = Number(entry.id);
            return Number.isFinite(numericId) ? Math.max(max, numericId) : max;
        }, 0);
        this.updateCustomPollIntervals([
            ...(native.customPollIntervals || []),
            {
                id: String(maxId + 1),
                name: "",
                intervalSeconds: 60,
            },
        ]);
    }

    private setDiscoverySearch(search: string): void {
        this.setState({ search, discoveryPage: 0 });
        if (this.searchDebounceTimer) {
            window.clearTimeout(this.searchDebounceTimer);
        }
        this.searchDebounceTimer = window.setTimeout(() => {
            this.searchDebounceTimer = null;
            this.setState({ searchDebounced: search });
        }, 500);
    }

    private updateIntervalProfile(index: number, patch: Partial<IntervalProfile>): void {
        const native = this.getNative();
        const rows = (native.customPollIntervals || []).map((entry, currentIndex) =>
            currentIndex === index ? { ...entry, ...patch } : entry,
        );
        this.updateCustomPollIntervals(rows);
    }

    private requestDeleteIntervalProfile(index: number): void {
        const native = this.getNative();
        const profile = (native.customPollIntervals || [])[index];
        if (!profile) {
            return;
        }

        this.setState({
            deleteDialogOpen: true,
            deleteProfileIndex: index,
            deleteTargetIntervalProfileId: DELETE_PROFILE_TARGET_UNSELECTED,
        });
    }

    private closeDeleteDialog(): void {
        this.setState({
            deleteDialogOpen: false,
            deleteProfileIndex: null,
            deleteTargetIntervalProfileId: DELETE_PROFILE_TARGET_UNSELECTED,
        });
    }

    private applyDeleteProfile(): void {
        const native = this.getNative();
        const profileIndex = this.state.deleteProfileIndex;
        if (profileIndex === null) {
            return;
        }

        const profile = (native.customPollIntervals || [])[profileIndex];
        if (!profile) {
            this.closeDeleteDialog();
            return;
        }

        const target =
            this.state.deleteTargetIntervalProfileId === DELETE_PROFILE_TARGET_UNSELECTED
                ? ""
                : this.state.deleteTargetIntervalProfileId || "";
        const customPollIntervals = (native.customPollIntervals || []).filter((_, index) => index !== profileIndex);
        const discoveredPointCatalog = (native.discoveredPointCatalog || []).map(entry =>
            String(entry.intervalProfileId || "") === String(profile.id || "")
                ? { ...entry, intervalProfileId: target }
                : entry,
        );

        this.updateNativeValue("customPollIntervals", customPollIntervals, () => {
            this.updateNativeValue("discoveredPointCatalog", discoveredPointCatalog, () => this.closeDeleteDialog());
        });
    }

    private async refreshDiscovery(): Promise<void> {
        const native = this.getNative();

        this.setState({
            discoveryLoading: true,
            discoveryStatus: I18n.t("Discovery running..."),
        });

        try {
            const response = await this.socket.sendTo<DiscoveredPoint[] | { error?: string }>(
                this.instanceId,
                "discoverPoints",
                {
                    baseUrl: native.baseUrl || "",
                    username: native.username || "",
                    password: native.password || "",
                    basicAuth: native.basicAuth || "",
                    ignoreTlsErrors: native.ignoreTlsErrors !== false,
                    deviceIds: native.deviceIds || "",
                },
            );

            if (!Array.isArray(response)) {
                throw new Error(response?.error || I18n.t("Discovery failed"));
            }

            const previousAssignments = new Map(
                (native.discoveredPointCatalog || []).map(entry => [
                    getPointKey(entry),
                    {
                        enabled: entry.enabled !== false,
                        intervalProfileId: entry.intervalProfileId || "",
                    },
                ]),
            );

            const catalog = response.map(entry => {
                const preserved = previousAssignments.get(getPointKey(entry));
                return {
                    ...entry,
                    deviceName: entry.deviceName || entry.deviceId || "",
                    enabled: preserved ? preserved.enabled : true,
                    intervalProfileId: preserved ? preserved.intervalProfileId : "",
                };
            });

            this.updateDiscoveredPointCatalog(catalog);
            this.setState({
                discoveryLoading: false,
                discoveryStatus: I18n.t("Discovery updated"),
            });
        } catch (error) {
            this.setState({
                discoveryLoading: false,
                discoveryStatus: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private renderConnectionSection(): React.JSX.Element {
        const native = this.getNative();
        const baseUrl = this.getBaseUrlParts();
        const hasBasicAuth = !!String(native.basicAuth || "").trim();
        const hasUserPass = !!String(native.username || "").trim() || !!String(native.password || "").trim();

        return (
            <Paper sx={{ p: 2.5, borderRadius: 2.5 }}>
                <Typography
                    variant="h6"
                    sx={{ mb: 2, mt: 0 }}
                >
                    {I18n.t("Connection")}
                </Typography>
                <Box
                    sx={{
                        display: "grid",
                        gridTemplateColumns: {
                            xs: "1fr",
                            md: "repeat(3, minmax(0, 1fr))",
                        },
                        gap: 2,
                    }}
                >
                    <TextField
                        select
                        size="small"
                        label={I18n.t("Protocol")}
                        value={baseUrl.protocol}
                        onChange={event => this.updateBaseUrlPart("protocol", event.target.value)}
                    >
                        <MenuItem value="https">https</MenuItem>
                        <MenuItem value="http">http</MenuItem>
                    </TextField>
                    <TextField
                        size="small"
                        label={I18n.t("Address")}
                        value={baseUrl.host}
                        onChange={event => this.updateBaseUrlPart("host", event.target.value)}
                    />
                    <TextField
                        size="small"
                        type="number"
                        label={I18n.t("Port")}
                        value={baseUrl.port}
                        onChange={event => this.updateBaseUrlPart("port", event.target.value)}
                    />

                    <TextField
                        size="small"
                        label={I18n.t("Username")}
                        value={native.username}
                        disabled={hasBasicAuth}
                        onChange={event => this.updateNativeField("username", event.target.value)}
                    />
                    <TextField
                        size="small"
                        type="password"
                        label={I18n.t("Password")}
                        value={native.password}
                        disabled={hasBasicAuth}
                        onChange={event => this.updateNativeField("password", event.target.value)}
                    />
                    <TextField
                        size="small"
                        label={I18n.t("Basic auth hash")}
                        value={native.basicAuth}
                        disabled={!hasBasicAuth && hasUserPass}
                        onChange={event => this.updateNativeField("basicAuth", event.target.value)}
                    />

                    <Alert
                        severity="info"
                        sx={{ gridColumn: "1 / -1", py: 0 }}
                    >
                        {I18n.t("Use either username/password or a basic auth hash.")}
                    </Alert>

                    <Box
                        sx={{
                            gridColumn: "1 / -1",
                            display: "grid",
                            gridTemplateColumns: { xs: "1fr", md: "minmax(220px, 360px) minmax(280px, 1fr)" },
                            gap: 1.5,
                            alignItems: "start",
                        }}
                    >
                        <TextField
                            size="small"
                            type="number"
                            label={I18n.t("Complete poll interval (seconds)")}
                            value={native.pollInterval}
                            inputProps={{ min: 10 }}
                            onChange={event =>
                                this.updateNativeField("pollInterval", Number(event.target.value) || 1800)
                            }
                        />
                        <Alert
                            severity="info"
                            sx={{ py: 0 }}
                        >
                            {I18n.t("In this interval all datapoints of the configured devices are fetched.")}
                        </Alert>
                    </Box>
                    <Box
                        sx={{
                            gridColumn: "1 / -1",
                            display: "grid",
                            gridTemplateColumns: { xs: "1fr", md: "minmax(220px, 360px) minmax(280px, 1fr)" },
                            gap: 1.5,
                            alignItems: "start",
                        }}
                    >
                        <TextField
                            size="small"
                            type="number"
                            label={I18n.t("Write lock interval (seconds)")}
                            value={native.writeLockInterval}
                            inputProps={{ min: 0 }}
                            onChange={event =>
                                this.updateNativeField("writeLockInterval", Math.max(Number(event.target.value) || 0, 0))
                            }
                        />
                        <Alert
                            severity="warning"
                            sx={{ py: 0 }}
                        >
                            {I18n.t(
                                "Recommended to keep a write lock interval to avoid excessive writes, which could damage the EEPROM of the device.",
                            )}
                        </Alert>
                    </Box>

                    <Box sx={{ gridColumn: "1 / -1" }}>
                        <FormLabel sx={{ mb: 0.5, display: "block", color: "text.primary" }}>
                            {I18n.t("State update mode")}
                        </FormLabel>
                        <RadioGroup
                            row
                            value={native.stateUpdateMode || "onValueChange"}
                            onChange={event =>
                                this.updateNativeField(
                                    "stateUpdateMode",
                                    event.target.value === "always" ? "always" : "onValueChange",
                                )
                            }
                        >
                            <FormControlLabel
                                value="onValueChange"
                                control={<Radio />}
                                label={I18n.t("Only on value change")}
                            />
                            <FormControlLabel
                                value="always"
                                control={<Radio />}
                                label={I18n.t("Always update")}
                            />
                        </RadioGroup>
                    </Box>

                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={native.ignoreTlsErrors !== false}
                                onChange={event => this.updateNativeField("ignoreTlsErrors", event.target.checked)}
                            />
                        }
                        label={I18n.t("Ignore TLS certificate errors")}
                    />
                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={native.fetchNotifications !== false}
                                onChange={event => this.updateNativeField("fetchNotifications", event.target.checked)}
                            />
                        }
                        label={I18n.t("Fetch notifications")}
                    />
                </Box>
            </Paper>
        );
    }

    private renderIntervalProfilesSection(): React.JSX.Element {
        const native = this.getNative();

        return (
            <Paper sx={{ p: 2.5, borderRadius: 2.5 }}>
                <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                    spacing={2}
                    sx={{ mb: 2 }}
                >
                    <Box>
                        <Typography variant="h6">{I18n.t("Custom poll intervals")}</Typography>
                        <Typography
                            variant="body2"
                            color="text.secondary"
                        >
                            {I18n.t(
                                "Create reusable interval profiles and assign them directly in the discovered points list below.",
                            )}
                        </Typography>
                    </Box>
                    <Button
                        variant="contained"
                        startIcon={<AddIcon />}
                        onClick={() => this.addIntervalProfile()}
                    >
                        {I18n.t("Add interval profile")}
                    </Button>
                </Stack>

                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>{I18n.t("Profile name")}</TableCell>
                                <TableCell>{I18n.t("Interval (seconds)")}</TableCell>
                                <TableCell>{I18n.t("Actions")}</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {(native.customPollIntervals || []).length ? (
                                (native.customPollIntervals || []).map((profile, index) => (
                                    <IntervalProfileRow
                                        key={profile.id || index}
                                        profile={profile}
                                        onChange={patch => this.updateIntervalProfile(index, patch)}
                                        onDelete={() => this.requestDeleteIntervalProfile(index)}
                                    />
                                ))
                            ) : (
                                <TableRow>
                                    <TableCell
                                        colSpan={3}
                                        sx={{ py: 3, color: "text.secondary", textAlign: "center" }}
                                    >
                                        {I18n.t("No interval profiles configured")}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        );
    }

    private renderDiscoverySection(): React.JSX.Element {
        const native = this.getNative();
        const filteredEntries = this.getFilteredDiscoveredEntries();
        const pageCount = Math.max(1, Math.ceil(filteredEntries.length / this.state.discoveryRowsPerPage));
        const currentPage = Math.min(this.state.discoveryPage, pageCount - 1);
        const pagedEntries = filteredEntries.slice(
            currentPage * this.state.discoveryRowsPerPage,
            (currentPage + 1) * this.state.discoveryRowsPerPage,
        );
        const deviceOptions = ["", ...this.getKnownDevices().map(device => {
            const displayName = device.configuredDisplayName || device.deviceName || device.deviceId;
            return `${device.deviceId}:::${displayName}`;
        })];

        return (
            <Paper sx={{ p: 2.5, borderRadius: 2.5 }}>
                <Stack
                    direction={{ xs: "column", md: "row" }}
                    justifyContent="space-between"
                    spacing={2}
                    sx={{ mb: 2 }}
                >
                    <Box>
                        <Typography variant="h6">{I18n.t("Discovery")}</Typography>
                        <Typography
                            variant="body2"
                            color="text.secondary"
                        >
                            {I18n.t(
                                "Discovery uses the currently running adapter instance. Save and restart first if you changed connection settings.",
                            )}
                        </Typography>
                    </Box>
                    <Button
                        variant="contained"
                        startIcon={<RefreshIcon />}
                        onClick={() => void this.refreshDiscovery()}
                        disabled={this.state.discoveryLoading}
                    >
                        {I18n.t("Refresh discovery")}
                    </Button>
                </Stack>

                {this.state.discoveryStatus ? (
                    <Alert
                        severity={this.state.discoveryLoading ? "info" : "success"}
                        sx={{ mb: 2 }}
                    >
                        {this.state.discoveryStatus}
                    </Alert>
                ) : null}

                <Box sx={{ mb: 2 }}>
                    <Typography
                        variant="subtitle2"
                        sx={{ mb: 1 }}
                    >
                        {I18n.t("Device display names")}
                    </Typography>
                    <Alert
                        severity="info"
                        sx={{ mb: 1.5, py: 0 }}
                    >
                        {I18n.t("Complete poll controls whether the device is included in the regular full device synchronization.")}
                    </Alert>
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>{I18n.t("Complete poll")}</TableCell>
                                    <TableCell>{I18n.t("Device ID")}</TableCell>
                                    <TableCell>{I18n.t("Device name")}</TableCell>
                                    <TableCell>{I18n.t("Display / folder name")}</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {this.getKnownDevices().length ? (
                                    this.getKnownDevices().map(device => (
                                        <TableRow key={device.deviceId}>
                                            <TableCell sx={{ width: 90 }}>
                                                <Checkbox
                                                    size="small"
                                                    checked={device.enabled}
                                                    onChange={event =>
                                                        this.updateKnownDeviceEnabled(device.deviceId, event.target.checked)
                                                    }
                                                />
                                            </TableCell>
                                            <TableCell>{device.deviceId}</TableCell>
                                            <TableCell>{device.deviceName || device.deviceId}</TableCell>
                                            <TableCell sx={{ width: "45%" }}>
                                                <TextField
                                                    fullWidth
                                                    size="small"
                                                    placeholder={device.deviceName || device.deviceId}
                                                    value={device.configuredDisplayName}
                                                    onChange={event =>
                                                        this.updateDeviceDisplayName(device.deviceId, event.target.value)
                                                    }
                                                />
                                            </TableCell>
                                        </TableRow>
                                    ))
                                ) : (
                                    <TableRow>
                                        <TableCell
                                            colSpan={4}
                                            sx={{ py: 2.5, color: "text.secondary", textAlign: "center" }}
                                        >
                                            {I18n.t("Run discovery first to configure device display names")}
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Box>

                <Box
                    sx={{
                        display: "grid",
                        gridTemplateColumns: {
                            xs: "1fr",
                            md: "minmax(260px, 2fr) repeat(4, minmax(120px, 1fr))",
                        },
                        gap: 1.5,
                        mb: 1.5,
                    }}
                >
                    <TextField
                        size="small"
                        label={I18n.t("Search")}
                        value={this.state.search}
                        onChange={event => this.setDiscoverySearch(event.target.value)}
                        InputProps={{
                            startAdornment: (
                                <InputAdornment position="start">
                                    <SearchIcon fontSize="small" />
                                </InputAdornment>
                            ),
                        }}
                    />
                    <TextField
                        select
                        size="small"
                        label={I18n.t("Enabled filter")}
                        value={this.state.enabledFilter}
                        onChange={event => this.setState({ enabledFilter: event.target.value, discoveryPage: 0 })}
                    >
                        <MenuItem value="">{I18n.t("All points")}</MenuItem>
                        <MenuItem value="yes">{I18n.t("Enabled only")}</MenuItem>
                        <MenuItem value="no">{I18n.t("Disabled only")}</MenuItem>
                    </TextField>
                    <TextField
                        select
                        size="small"
                        label={I18n.t("Device filter")}
                        value={this.state.deviceIdFilter}
                        onChange={event => this.setState({ deviceIdFilter: event.target.value, discoveryPage: 0 })}
                    >
                        <MenuItem value="">{I18n.t("All devices")}</MenuItem>
                        {deviceOptions.filter(Boolean).map(deviceKey => {
                            const [deviceId, displayName] = deviceKey.split(":::");
                            return (
                                <MenuItem
                                    key={deviceId}
                                    value={deviceId}
                                >
                                    {displayName || deviceId}
                                </MenuItem>
                            );
                        })}
                    </TextField>
                    <TextField
                        select
                        size="small"
                        label={I18n.t("Writable filter")}
                        value={this.state.writableFilter}
                        onChange={event => this.setState({ writableFilter: event.target.value, discoveryPage: 0 })}
                    >
                        <MenuItem value="">{I18n.t("All points")}</MenuItem>
                        <MenuItem value="yes">{I18n.t("Writable only")}</MenuItem>
                        <MenuItem value="no">{I18n.t("Read-only only")}</MenuItem>
                    </TextField>
                    <TextField
                        select
                        size="small"
                        label={I18n.t("Interval filter")}
                        value={this.state.intervalFilter}
                        onChange={event => this.setState({ intervalFilter: event.target.value, discoveryPage: 0 })}
                    >
                        <MenuItem value="">{I18n.t("All intervals")}</MenuItem>
                        <MenuItem value={COMPLETE_POLL_FILTER_VALUE}>{I18n.t("Complete poll interval")}</MenuItem>
                        {this.getIntervalProfileOptions()
                            .filter(option => option.value)
                            .map(option => (
                                <MenuItem
                                    key={option.value}
                                    value={option.value}
                                >
                                    {option.label}
                                </MenuItem>
                            ))}
                    </TextField>
                </Box>

                <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    sx={{ mb: 1.5, flexWrap: "wrap" }}
                >
                    <Button onClick={() => this.setAllFilteredPointsEnabled(true)}>{I18n.t("Select all")}</Button>
                    <Button onClick={() => this.setAllFilteredPointsEnabled(false)}>{I18n.t("Deselect all")}</Button>
                    <Button
                        onClick={() =>
                            this.setState({
                                search: "",
                                searchDebounced: "",
                                enabledFilter: "",
                                deviceIdFilter: "",
                                writableFilter: "",
                                intervalFilter: "",
                                discoveryPage: 0,
                            })
                        }
                    >
                        {I18n.t("Reset filters")}
                    </Button>
                    <Chip
                        size="small"
                        label={`${filteredEntries.length} / ${(native.discoveredPointCatalog || []).length}`}
                    />
                </Stack>

                <TableContainer
                    sx={{
                        maxHeight: "min(62vh, calc(100vh - 320px))",
                        mb: 0,
                        border: theme => `1px solid ${theme.palette.divider}`,
                        borderRadius: 2,
                        position: "relative",
                        zIndex: 0,
                        "& .MuiTableCell-stickyHeader": {
                            zIndex: 2,
                            backgroundColor: theme => theme.palette.background.paper,
                        },
                        "& .MuiTableHead-root": {
                            position: "relative",
                            zIndex: 2,
                        },
                        "& .MuiTableBody-root": {
                            position: "relative",
                            zIndex: 0,
                        },
                        "& .MuiTableRow-root": {
                            position: "relative",
                            zIndex: 0,
                        },
                        "& .MuiCheckbox-root, & .MuiInputBase-root, & .MuiSelect-root, & .MuiButtonBase-root": {
                            position: "relative",
                            zIndex: 0,
                        },
                    }}
                >
                    {!this.state.discoveryUiReady ? (
                        <Box sx={{ p: 3 }}>
                            <Alert severity="info">{I18n.t("Preparing discovery list...")}</Alert>
                        </Box>
                    ) : (
                        <Table
                            size="small"
                            stickyHeader
                        >
                            <TableHead>
                                <TableRow>
                                    <TableCell>{I18n.t("Enabled")}</TableCell>
                                    <TableCell>{I18n.t("Device")}</TableCell>
                                    <TableCell>{I18n.t("Point ID")}</TableCell>
                                    <TableCell>{I18n.t("Title")}</TableCell>
                                    <TableCell align="right">{I18n.t("Current value")}</TableCell>
                                    <TableCell>{I18n.t("Unit")}</TableCell>
                                    <TableCell>{I18n.t("Writable")}</TableCell>
                                    <TableCell>{I18n.t("Interval profile")}</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {filteredEntries.length ? (
                                    pagedEntries.map(entry => (
                                        <TableRow
                                            hover
                                            key={getPointKey(entry)}
                                        >
                                            <TableCell sx={{ py: 0.25 }}>
                                                <Checkbox
                                                    size="small"
                                                    checked={entry.enabled !== false}
                                                    onChange={event =>
                                                        this.updatePoint(entry, current => ({
                                                            ...current,
                                                            enabled: event.target.checked,
                                                            intervalProfileId: event.target.checked
                                                                ? current.intervalProfileId || ""
                                                                : "",
                                                        }))
                                                    }
                                                />
                                            </TableCell>
                                            <TableCell sx={{ py: 0.25 }}>
                                                {this.getKnownDevices().find(device => device.deviceId === entry.deviceId)?.configuredDisplayName ||
                                                    this.getKnownDevices().find(device => device.deviceId === entry.deviceId)?.deviceName ||
                                                    entry.deviceId}
                                            </TableCell>
                                            <TableCell sx={{ py: 0.25 }}>{entry.pointId}</TableCell>
                                            <TableCell sx={{ py: 0.25 }}>{entry.title}</TableCell>
                                            <TableCell
                                                align="right"
                                                sx={{ py: 0.25 }}
                                            >
                                                {formatCurrentValue(entry.currentValue)}
                                            </TableCell>
                                            <TableCell sx={{ py: 0.25 }}>{entry.unit || ""}</TableCell>
                                            <TableCell sx={{ py: 0.25 }}>
                                                {entry.writable ? I18n.t("Yes") : I18n.t("No")}
                                            </TableCell>
                                            <TableCell sx={{ py: 0.25, minWidth: 260 }}>
                                                <Select
                                                    fullWidth
                                                    size="small"
                                                    value={entry.intervalProfileId || ""}
                                                    displayEmpty
                                                    renderValue={selected => {
                                                        const selectedValue = String(selected || "");
                                                        const option = this.getIntervalProfileOptions().find(
                                                            current => current.value === selectedValue,
                                                        );
                                                        return option?.label || I18n.t("Complete poll interval");
                                                    }}
                                                    onChange={event =>
                                                        this.updatePoint(entry, current => ({
                                                            ...current,
                                                            intervalProfileId: String(event.target.value || ""),
                                                            enabled: true,
                                                        }))
                                                    }
                                                >
                                                    {this.getIntervalProfileOptions().map(option => (
                                                        <MenuItem
                                                            key={option.value || "complete"}
                                                            value={option.value}
                                                        >
                                                            {option.label}
                                                        </MenuItem>
                                                    ))}
                                                </Select>
                                            </TableCell>
                                        </TableRow>
                                    ))
                                ) : (
                                    <TableRow>
                                        <TableCell
                                            colSpan={8}
                                            sx={{ py: 3, color: "text.secondary", textAlign: "center" }}
                                        >
                                            {I18n.t("No points discovered yet")}
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    )}
                </TableContainer>
                <Stack
                    direction={{ xs: "column", md: "row" }}
                    spacing={2}
                    alignItems={{ xs: "stretch", md: "center" }}
                    justifyContent="space-between"
                    sx={{ pt: 1.5 }}
                >
                    <Stack
                        direction="row"
                        spacing={1.5}
                        alignItems="center"
                        flexWrap="wrap"
                    >
                        <TextField
                            select
                            size="small"
                            label={I18n.t("Rows per page")}
                            value={String(this.state.discoveryRowsPerPage)}
                            onChange={event =>
                                this.setState({
                                    discoveryRowsPerPage: Number(event.target.value) || DEFAULT_DISCOVERY_ROWS_PER_PAGE,
                                    discoveryPage: 0,
                                })
                            }
                            sx={{ minWidth: 140 }}
                        >
                            {DISCOVERY_ROWS_PER_PAGE_OPTIONS.map(option => (
                                <MenuItem
                                    key={option}
                                    value={String(option)}
                                >
                                    {option}
                                </MenuItem>
                            ))}
                        </TextField>
                        <Typography
                            variant="body2"
                            color="text.secondary"
                        >
                            {`${I18n.t("Page")} ${currentPage + 1} / ${pageCount}`}
                        </Typography>
                    </Stack>
                    <Pagination
                        color="primary"
                        page={currentPage + 1}
                        count={pageCount}
                        siblingCount={1}
                        boundaryCount={1}
                        showFirstButton
                        showLastButton
                        onChange={(_, page) => this.setState({ discoveryPage: page - 1 })}
                    />
                </Stack>
            </Paper>
        );
    }

    private renderDeleteDialog(): React.JSX.Element {
        const native = this.getNative();
        const profileIndex = this.state.deleteProfileIndex;
        const profile = profileIndex === null ? null : (native.customPollIntervals || [])[profileIndex];
        const affectedPoints = profile
            ? (native.discoveredPointCatalog || []).filter(
                  entry => String(entry.intervalProfileId || "") === String(profile.id || ""),
              )
            : [];

        const alternatives = [
            {
                value: DELETE_PROFILE_TARGET_UNSELECTED,
                label: I18n.t("Select profile..."),
            },
            {
                value: "",
                label: `${I18n.t("Complete poll interval")} (${Number(native.pollInterval || 1800)}s)`,
            },
            ...(native.customPollIntervals || [])
                .filter((_, index) => index !== profileIndex)
                .map(entry => ({
                    value: String(entry.id || ""),
                    label: `${entry.name || entry.id} (${Number(entry.intervalSeconds || 0)}s)`,
                })),
        ];

        return (
            <Dialog
                open={this.state.deleteDialogOpen}
                onClose={() => this.closeDeleteDialog()}
                fullWidth
                maxWidth="md"
            >
                <DialogTitle>{I18n.t("Delete interval profile")}</DialogTitle>
                <DialogContent dividers>
                    {profile ? (
                        <Stack spacing={2}>
                            <Typography variant="body2">
                                {affectedPoints.length
                                    ? I18n.t(
                                          "This profile is still used by points. Reassign them before deleting the profile.",
                                      )
                                    : I18n.t("This profile is not currently used. You can delete it directly.")}
                            </Typography>
                            {affectedPoints.length ? (
                                <>
                                    <TextField
                                        select
                                        fullWidth
                                        size="small"
                                        label={I18n.t("Move affected points to")}
                                        value={this.state.deleteTargetIntervalProfileId}
                                        SelectProps={{
                                            displayEmpty: true,
                                            renderValue: selected => {
                                                const selectedValue = String(selected || "");
                                                const option = alternatives.find(current => current.value === selectedValue);
                                                return option?.label || I18n.t("Select profile...");
                                            },
                                        }}
                                        onChange={event =>
                                            this.setState({ deleteTargetIntervalProfileId: event.target.value })
                                        }
                                    >
                                        {alternatives.map(option => (
                                            <MenuItem
                                                key={option.value || "complete"}
                                                value={option.value}
                                            >
                                                {option.label}
                                            </MenuItem>
                                        ))}
                                    </TextField>
                                    <TableContainer>
                                        <Table size="small">
                                            <TableHead>
                                                <TableRow>
                                                    <TableCell>{I18n.t("Point")}</TableCell>
                                                    <TableCell>{I18n.t("Current profile")}</TableCell>
                                                </TableRow>
                                            </TableHead>
                                            <TableBody>
                                                {affectedPoints.map(point => (
                                                    <TableRow key={getPointKey(point)}>
                                                        <TableCell>{`${point.title} (${point.deviceId} / ${point.pointId})`}</TableCell>
                                                        <TableCell>{profile.name || profile.id}</TableCell>
                                                    </TableRow>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    </TableContainer>
                                </>
                            ) : null}
                        </Stack>
                    ) : null}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => this.closeDeleteDialog()}>{I18n.t("Cancel")}</Button>
                    <Button
                        variant="contained"
                        color="error"
                        disabled={
                            affectedPoints.length > 0 &&
                            this.state.deleteTargetIntervalProfileId === DELETE_PROFILE_TARGET_UNSELECTED
                        }
                        onClick={() => this.applyDeleteProfile()}
                    >
                        {affectedPoints.length ? I18n.t("Delete and reassign") : I18n.t("Delete profile")}
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    public override render(): React.JSX.Element {
        if (!this.state.loaded) {
            return <Loader themeType={this.state.themeType} />;
        }

        return (
            <ThemeProvider theme={this.state.theme}>
                <CssBaseline />
                <Box
                    sx={{
                        p: 2,
                        pb: 18,
                        minHeight: "100%",
                        maxWidth: 1600,
                        mx: "auto",
                        color: "text.primary",
                        overflowY: "auto",
                        boxSizing: "border-box",
                    }}
                >
                    <Stack
                        direction={{ xs: "column", md: "row" }}
                        spacing={3}
                        alignItems={{ xs: "flex-start", md: "center" }}
                        sx={{ mb: 3 }}
                    >
                        <Box
                            component="img"
                            src={logoUrl}
                            alt="NIBE REST API"
                            sx={{ width: 320, maxWidth: "100%", height: "auto" }}
                        />
                        <Box>
                            <Typography
                                variant="h5"
                                sx={{ mt: 0, mb: 0.5 }}
                            >
                                NIBE REST API
                            </Typography>
                            <Typography
                                variant="body2"
                                color="text.secondary"
                            >
                                {I18n.t("Custom polling profiles and point assignments for faster updates.")}
                            </Typography>
                        </Box>
                    </Stack>

                    <Stack spacing={2.5}>
                        {this.renderConnectionSection()}
                        {this.renderIntervalProfilesSection()}
                        {this.renderDiscoverySection()}
                    </Stack>

                    {this.renderDeleteDialog()}
                    {this.renderHelperDialogs()}
                </Box>
            </ThemeProvider>
        );
    }
}
