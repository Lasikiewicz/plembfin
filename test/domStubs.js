const values = new Map();
globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), clear: () => values.clear() };
globalThis.window = { location: { origin: "http://localhost:5055", protocol: "http:" }, addEventListener() {}, scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 720 };
globalThis.document = { title: "Plembfin", hidden: false, visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
globalThis.history = { pushState() {}, replaceState() {} };
