// Electron wraps rejected IPC promises with transport details. Keep the
// service's actionable explanation in product UI, without the channel name.
export const errorMessage = (message: string) =>
  message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
