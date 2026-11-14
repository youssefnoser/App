// Display-only false colour: ES Table 2 gives the 0.744–5.002 µm range.
// Violet means shorter infrared wavelengths, red longer ones; these are not
// visible colours of the sources. No science pixels or NaN masks are changed.
const STOPS = [[.65,.4,1],[.25,.55,1],[.2,1,1],[.3,1,.6],[1,.9,.3],[1,.3,.2]];
export function wavelengthRGB(wavelength: number): number[] {
  if (!Number.isFinite(wavelength)) return [1,1,1];
  const t=Math.max(0,Math.min(1,(wavelength-.744)/(5.002-.744)))*(STOPS.length-1);
  const i=Math.min(STOPS.length-2,Math.floor(t)), f=t-i;
  return STOPS[i].map((v,c)=>v+(STOPS[i+1][c]-v)*f);
}
// Map displayed luminance to a single wavelength colour. Black stays black;
// alpha is preserved. Missing wavelength gives a neutral luminance image.
export function wavelengthMatrix(wavelength: number): string {
  return [...wavelengthRGB(wavelength).flatMap(c=>[.2126*c,.7152*c,.0722*c,0,0]),0,0,0,1,0].join(' ');
}
