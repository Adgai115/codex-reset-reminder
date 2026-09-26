// Compatibility shim: the module moved to core/. Existing CLI entry points,
// tests and PowerShell launchers keep importing from the project root.
export * from './core/store.mjs';
