export function cameraPermissions(platform: string): { command?: string; instructions: string } {
  if (/^Mac/i.test(platform)) return {
    command: "camera-settings-macos",
    instructions: "In System Settings → Privacy & Security → Camera, allow Buzz if listed. Camera capture requires support from the Buzz desktop app. If Buzz is missing here, this plugin cannot enable camera access.",
  };
  if (/^Win/i.test(platform)) return {
    command: "camera-settings-windows",
    instructions: "In Settings → Privacy & security → Camera, enable Camera access and Let desktop apps access your camera.",
  };
  return {
    instructions: "Open your desktop’s privacy or application settings and allow camera access for Buzz. If you use Buzz in a browser, also allow camera access for this site.",
  };
}
