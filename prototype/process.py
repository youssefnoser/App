import warnings; warnings.filterwarnings('ignore')
import json, sys, base64, numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.coordinates import SkyCoord
from astropy.time import Time
import astropy.units as u
from scipy.ndimage import map_coordinates
name=sys.argv[1]
M=json.load(open(f'meta_{name}.json')); T=M['T']; rows=M['rows']; RA,DEC=M['ra'],M['dec']
c0=SkyCoord(T['ra']*u.deg,T['dec']*u.deg,pm_ra_cosdec=T['pmra']*u.mas/u.yr,pm_dec=T['pmdec']*u.mas/u.yr,obstime=Time('J2000'))
N=41; SCALE=3.075/3600  # deg/px
# north-up, east-left tangent-plane output grid
ow=WCS(naxis=2); ow.wcs.ctype=['RA---TAN','DEC--TAN']; ow.wcs.crval=[RA,DEC]
ow.wcs.crpix=[(N+1)/2,(N+1)/2]; ow.wcs.cdelt=[-SCALE,SCALE]
yy,xx=np.mgrid[0:N,0:N]
og=ow.pixel_to_world(xx,yy)
sr_px=(SCALE*np.pi/180)**2
frames=[]
for i,row in enumerate(rows):
    h=fits.open(f'cut_{name}/{i:04d}.fits')
    hd=h[1].header; img=h[1].data.astype(float)
    w=WCS(hd)
    px,py=w.world_to_pixel(og)
    out=map_coordinates(img,[py,px],order=1,mode='constant',cval=np.nan)
    mjd=hd['MJD-AVG']
    pos=c0.apply_space_motion(new_obstime=Time(mjd,format='mjd'))
    tx,ty=ow.world_to_pixel(pos)
    # wavelength at the target
    sx,sy=w.world_to_pixel(pos)
    sw=WCS(hd,fobj=h,key='W'); sw.sip=None
    wl,bw=sw.pixel_to_world(sx,sy)
    wl=float(wl.to(u.um).value); bw=float(bw.to(u.um).value)
    # aperture photometry on the reprojected frame
    r=np.hypot(xx-tx,yy-ty)
    ap=r<=2.5; bk=(r>=7)&(r<=12)
    bkg=np.nanmedian(out[bk]) if np.isfinite(out[bk]).sum()>10 else np.nan
    fa=np.isfinite(out[ap])
    flux=np.nanmean((out-bkg)[ap])*ap.sum()*sr_px*1e6 if fa.mean()>=0.7 else np.nan  # Jy
    noise=np.nanstd(out[bk])*np.sqrt(ap.sum())*sr_px*1e6 if np.isfinite(out[bk]).sum()>10 else np.nan
    frames.append(dict(i=i,mjd=mjd,det=int(hd['DETECTOR']),wl=wl,bw=bw,tx=float(tx),ty=float(ty),flux=float(flux),err=float(noise),
        obs=hd.get('OBSID'),ok=bool(np.isfinite(out).mean()>0.9),img=out.astype(np.float32)))
frames.sort(key=lambda f:f['mjd'])
good=[f for f in frames if f['ok'] and np.isfinite(f['wl'])]
print(len(frames),'frames;',len(good),'good')
print('mjd',good[0]['mjd'],good[-1]['mjd'],'wl',min(f['wl'] for f in good),max(f['wl'] for f in good))
print('flux sample',[(round(f['wl'],2),round(f['flux'],3)) for f in good[::40]])
arr=np.stack([f['img'] for f in good])
meta=[{k:(None if (isinstance(v,float) and not np.isfinite(v)) else v) for k,v in f.items() if k not in('img','ok')} for f in good]
iso=lambda m:Time(m,format='mjd').iso[:10]
for f in meta: f['date']=iso(f['mjd'])
out=dict(name=name,ra=RA,dec=DEC,N=N,scale_arcsec=SCALE*3600,frames=meta,
  pm=dict(ra=T['pmra'],dec=T['pmdec']),
  data=base64.b64encode(arr.astype('<f4').tobytes()).decode())
json.dump(out,open(f'{name}_viewer.json','w'),separators=(',',':'))
import os; print('json MB',os.path.getsize(f'{name}_viewer.json')/1e6)
