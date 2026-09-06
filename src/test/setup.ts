import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "new-scene-id", subtle: webcrypto.subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, configurable: true });
Object.defineProperty(URL, "createObjectURL", { value: () => `blob:test-${Math.random()}`, configurable: true });
Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
