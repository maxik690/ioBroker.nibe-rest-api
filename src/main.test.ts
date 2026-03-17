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
