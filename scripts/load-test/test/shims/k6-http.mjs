// Node stand-in for k6/http: unit tests must not make requests.
function unavailable() {
    throw new Error('k6/http is not available in unit tests');
}
const http = { get: unavailable, post: unavailable, batch: unavailable };
export default http;
