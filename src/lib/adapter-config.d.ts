// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            baseUrl: string;
            username: string;
            password: string;
            basicAuth: string;
            pollInterval: number;
            writeLockInterval: number;
            deviceIds: string;
            ignoreTlsErrors: boolean;
            fetchNotifications: boolean;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
