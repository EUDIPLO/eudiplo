import MCR from 'monocart-coverage-reports';
import { coverageEnabled, coverageOptions } from './coverage';

// Clears coverage from earlier runs and merges this run's data into
// coverage/e2e (HTML, LCOV, Cobertura) once all tests are done.
export default async function globalSetup() {
  if (!coverageEnabled) {
    return;
  }
  MCR(coverageOptions).cleanCache();
  return async () => {
    await MCR(coverageOptions).generate();
  };
}
