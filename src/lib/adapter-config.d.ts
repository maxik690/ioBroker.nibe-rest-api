// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface CustomPollIntervalConfig {
            id?: string;
            name?: string;
            intervalSeconds?: number;
        }

        interface DiscoveredPointConfig {
            enabled?: boolean;
            deviceId?: string;
            pointId?: number;
            title?: string;
            writable?: boolean;
            unit?: string;
            stateId?: string;
            currentValue?: ioBroker.StateValue;
        }

        interface CustomPointPollConfig {
            enabled?: boolean;
            deviceId?: string;
            pointId?: number;
            intervalProfileId?: string;
        }

        interface AdapterConfig {
            baseUrl: string;
            username: string;
            password: string;
            basicAuth: string;
            pollInterval: number;
            writeLockInterval: number;
            discoveredPointCatalog?: DiscoveredPointConfig[];
            customPollIntervals?: CustomPollIntervalConfig[];
            customPointPolls?: CustomPointPollConfig[];
            deviceIds: string;
            ignoreTlsErrors: boolean;
            fetchNotifications: boolean;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
