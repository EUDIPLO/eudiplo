import { describe, expect, it } from "vitest";
import { IssuerRegistrationCertificateLock } from "./issuer-registration-certificate-lock.js";

describe("IssuerRegistrationCertificateLock", () => {
    it("runs the tasks of one tenant one after another", async () => {
        const lock = new IssuerRegistrationCertificateLock();
        const order: string[] = [];
        let finishFirst!: () => void;
        const first = lock.run(
            "t",
            () =>
                new Promise<void>((resolve) => {
                    order.push("first started");
                    finishFirst = () => {
                        order.push("first done");
                        resolve();
                    };
                }),
        );
        const second = lock.run("t", async () => {
            order.push("second");
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        finishFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(["first started", "first done", "second"]);
    });

    it("runs the next task after a failed one", async () => {
        const lock = new IssuerRegistrationCertificateLock();
        const failed = lock.run("t", async () => {
            throw new Error("registrar down");
        });
        const next = lock.run("t", async () => "renewed");

        await expect(failed).rejects.toThrow("registrar down");
        await expect(next).resolves.toBe("renewed");
    });

    it("does not make other tenants wait", async () => {
        const lock = new IssuerRegistrationCertificateLock();
        void lock.run("a", () => new Promise(() => undefined));
        await expect(lock.run("b", async () => "b")).resolves.toBe("b");
    });
});
