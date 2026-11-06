// Fixed entry point for the Windows service and the developer command.
process.argv.push('--commercial');
await import('./start-app.mjs');
