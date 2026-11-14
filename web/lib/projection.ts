// Sky (ICRS RA, Dec in degrees) to screen pixels for the Stellarium engine's current view.
// Moved unchanged from SkyCanvas so overlays can place HTML markers. Returns null when the
// engine is not ready; visible is false behind the camera or more than 250 px off screen.

export function projectSkyToScreen(
  stel: any,
  raDeg: number,
  decDeg: number,
  width: number,
  height: number
): { x: number; y: number; visible: boolean } | null {
  if (!stel?.core?.observer) return null;

  try {
    const astrom = stel.s2c(raDeg * Math.PI / 180, decDeg * Math.PI / 180);
    const [cx, cy, cz] = stel.convertFrame(stel.observer, 'ASTROM', 'CIRS', astrom);

    const yaw = stel.core.observer.yaw;
    const pitch = stel.core.observer.pitch;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;

    // Pure JavaScript 3D rotation matrix from ICRF to camera VIEW frame
    // Rot_Z(-yaw) -> Rot_Y(pitch) -> R2GL coordinate mapping
    const cosYaw = Math.cos(-yaw), sinYaw = Math.sin(-yaw);
    const x1 = cosYaw * cx - sinYaw * cy;
    const y1 = sinYaw * cx + cosYaw * cy;
    const z1 = cz;

    const cosPitch = Math.cos(pitch), sinPitch = Math.sin(pitch);
    const x2 = cosPitch * x1 + sinPitch * z1;
    const y2 = y1;
    const z2 = -sinPitch * x1 + cosPitch * z1;

    const vx = -y2;
    const vy = z2;
    const vz = -x2;

    // In VIEW frame: camera looks down along -Z (depth is -vz).
    // If vz >= -0.0001, the celestial point is behind the camera.
    if (vz >= -0.0001) {
      return { x: -9999, y: -9999, visible: false };
    }

    const aspect = width / height;
    const fov = stel.core.fov || (50 * Math.PI) / 180;
    const fovy = aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspect) : fov;
    const f = 1 / Math.tan(fovy / 2);

    const depth = -vz;
    const xNdc = (vx / depth) * (f / aspect);
    const yNdc = (vy / depth) * f;

    const screenX = ((xNdc + 1) / 2) * width;
    const screenY = ((-yNdc + 1) / 2) * height;

    const visible = screenX >= -250 && screenX <= width + 250 && screenY >= -250 && screenY <= height + 250;
    return { x: screenX, y: screenY, visible };
  } catch {
    return null;
  }
}
