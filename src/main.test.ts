import { expect } from "chai";
import { NibeRestApi } from "./main";

describe("point state id normalization", () => {
    const adapter = new NibeRestApi({ name: "nibe-rest-api-test" });

    after(() => {
        adapter.removeAllListeners();
    });

    it("removes invisible separators inside words", () => {
        const softHyphenTitle = `Com${String.fromCharCode(0x00ad)}pressor fre${String.fromCharCode(0x00ad)}quency`;
        const stateId = (
            adapter as unknown as { getPointStateBaseName: (title: string) => string }
        ).getPointStateBaseName(softHyphenTitle);

        expect(stateId).to.equal("Compressor_frequency");
    });

    it("strips accents while keeping readable ids", () => {
        const stateId = (
            adapter as unknown as { getPointStateBaseName: (title: string) => string }
        ).getPointStateBaseName("Värmebärare temperatur");

        expect(stateId).to.equal("Varmebarare_temperatur");
    });
});

describe("write lock interval", () => {
    const adapter = new NibeRestApi({ name: "nibe-rest-api-test-lock" });
    const adapterInternals = adapter as unknown as {
        config: { writeLockInterval?: number };
        ensureWriteLockElapsed: (stateId: string) => void;
        lastSuccessfulWrites: Map<string, number>;
    };

    after(() => {
        adapter.removeAllListeners();
    });

    afterEach(() => {
        adapterInternals.lastSuccessfulWrites.clear();
        adapterInternals.config.writeLockInterval = 120;
    });

    it("blocks writes until the configured lock interval has elapsed", () => {
        adapterInternals.config.writeLockInterval = 120;
        adapterInternals.lastSuccessfulWrites.set("devices.test.aidMode", Date.now());

        expect(() => adapterInternals.ensureWriteLockElapsed("devices.test.aidMode")).to.throw(
            "Write lock active for devices.test.aidMode. Try again in 120s",
        );
    });

    it("allows writes again after the configured lock interval", () => {
        adapterInternals.config.writeLockInterval = 120;
        adapterInternals.lastSuccessfulWrites.set("devices.test.aidMode", Date.now() - 121_000);

        expect(() => adapterInternals.ensureWriteLockElapsed("devices.test.aidMode")).not.to.throw();
    });

    it("disables the write lock when the interval is set to 0", () => {
        adapterInternals.config.writeLockInterval = 0;
        adapterInternals.lastSuccessfulWrites.set("devices.test.aidMode", Date.now());

        expect(() => adapterInternals.ensureWriteLockElapsed("devices.test.aidMode")).not.to.throw();
    });
});
