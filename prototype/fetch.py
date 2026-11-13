import requests, csv, io, sys, os, warnings, json, time
warnings.filterwarnings('ignore')
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.coordinates import SkyCoord
from astropy.time import Time
import astropy.units as u
from concurrent.futures import ThreadPoolExecutor
name=sys.argv[1]
T={
 'barnard': dict(ra=269.45207, dec=4.69339, pmra=-798.58, pmdec=10328.12, plx=546.98),
 'wise0855': dict(ra=133.79512917, dec=-7.24514722, pmra=-8143, pmdec=680, plx=439),
}[name]
c0=SkyCoord(T['ra']*u.deg,T['dec']*u.deg,pm_ra_cosdec=T['pmra']*u.mas/u.yr,pm_dec=T['pmdec']*u.mas/u.yr,obstime=Time('J2000'))
mid=c0.apply_space_motion(new_obstime=Time(61000,format='mjd'))
ra,dec=mid.ra.deg,mid.dec.deg
print(name,'center',ra,dec)
size=0.05
q=f"""SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname
FROM spherex.artifact a JOIN spherex.plane p ON a.planeid=p.planeid
WHERE 1=CONTAINS(POINT('ICRS',{ra},{dec}),p.poly) ORDER BY p.time_bounds_lower"""
r=requests.post("https://irsa.ipac.caltech.edu/TAP/sync",data=dict(REQUEST="doQuery",LANG="ADQL",FORMAT="csv",QUERY=q),verify=False,timeout=180)
rows=list(csv.DictReader(io.StringIO(r.text)))
print(len(rows),'images')
os.makedirs(f'cut_{name}',exist_ok=True)
def get(i):
    row=rows[i]
    fn=f'cut_{name}/{i:04d}.fits'
    if not os.path.exists(fn):
        url=f"https://irsa.ipac.caltech.edu/{row['uri']}?center={ra},{dec}d&size={size}"
        for k in range(3):
            try:
                rr=requests.get(url,verify=False,timeout=180); rr.raise_for_status()
                open(fn,'wb').write(rr.content); break
            except Exception as e:
                err=e; time.sleep(2)
        else:
            return i,str(err)
    return i,None
t=time.time()
with ThreadPoolExecutor(8) as ex:
    res=list(ex.map(get,range(len(rows))))
bad=[x for x in res if x[1]]
print('done',time.time()-t,'s; failed',len(bad),bad[:3])
json.dump(dict(rows=rows,ra=ra,dec=dec,size=size,T=T),open(f'meta_{name}.json','w'))
