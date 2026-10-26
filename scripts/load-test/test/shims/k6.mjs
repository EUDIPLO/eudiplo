// Node stand-in for the k6 module: fail() throws, check() evaluates.
export function fail(message) {
    throw new Error(message);
}
export function check(value, sets) {
    return Object.values(sets).every((fn) => fn(value));
}
export function group(_name, fn) {
    return fn();
}
export function sleep() {}
export default { fail, check, group, sleep };
