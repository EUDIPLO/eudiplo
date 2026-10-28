// Own members of the built-ins a walk into an inherited member reaches, by
// identity, so added and overwritten members both show up
export function builtInShape(): Map<string, unknown> {
    const targets = [
        Object.prototype,
        Object,
        Function.prototype,
        Array.prototype,
        Object.prototype.toString,
        Object.prototype.hasOwnProperty,
    ];
    const shape = new Map<string, unknown>();
    targets.forEach((target, index) => {
        for (const key of Reflect.ownKeys(target)) {
            const descriptor = Object.getOwnPropertyDescriptor(target, key);
            shape.set(
                `${index}:${String(key)}`,
                descriptor?.value ?? descriptor?.get,
            );
        }
    });
    return shape;
}

export function changedBuiltIns(before: Map<string, unknown>): string[] {
    const after = builtInShape();
    return [...new Set([...before.keys(), ...after.keys()])].filter(
        (key) =>
            before.has(key) !== after.has(key) ||
            !Object.is(before.get(key), after.get(key)),
    );
}
