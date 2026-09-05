import { RuntimeSettings } from './runtime-settings.mjs';

try {
  RuntimeSettings.fromEnvironment(process.env);
} catch (error) {
  console.error(error.code === 'INVALID_CONFIGURATION' ? error.message : 'Configuration validation failed');
  process.exitCode = 1;
}
