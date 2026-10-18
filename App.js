import React, { useEffect, useMemo, useRef, useState } from 'react';
import Svg, { Path, Circle, Defs, LinearGradient, Stop, Rect, Polygon } from 'react-native-svg';
import * as FileSystem from 'expo-file-system/legacy';
import * as Notifications from 'expo-notifications';
import * as IntentLauncher from 'expo-intent-launcher';
import * as SplashScreen from 'expo-splash-screen';
import * as BackgroundTask from 'expo-background-task';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as MediaLibrary from 'expo-media-library';
import * as ImageManipulator from 'expo-image-manipulator';
import * as CFG from './config';
import { GH_REPO, BUILD } from './repo';
import * as RP from './repo';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Alert, ScrollView, Modal, Image, TextInput, RefreshControl, Dimensions, Platform, Linking, ActivityIndicator, Animated, Easing, PanResponder, useColorScheme } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { SUPA_URL, SUPA_KEY } from './config';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

SplashScreen.preventAutoHideAsync().catch(() => {});
const DARK = { bg: '#000000', card: '#1C1C21', line: '#2C2C34', text: '#FFFFFF', dim: '#9A9AA3', accent: '#6EC7C7', warn: '#FF9500', sel: '#2E4545' };
const LIGHT = { bg: '#F2F2F7', card: '#FFFFFF', line: '#D8D8DE', text: '#111114', dim: '#6B6B75', accent: '#2A9D9D', warn: '#E68600', sel: '#CFE8E8' };
let C = DARK, s = null, curTheme = '';
const SKEY = '@apexdrive_settings', CKEY = '@apexdrive_cells', VKEY = '@apexdrive_vehicle', FKEY = '@apexdrive_friends', PKEY = '@apexdrive_profile', KEY = '@apexdrive_trips', RKEY = '@apexdrive_regions', TASK = 'apexdrive-bg', G = 9.81;

const hav = (a, b) => {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * r, dLon = (b.longitude - a.longitude) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const fmtTime = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`; };
const fmtDate = (t) => new Date(t).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---- Sürüş motoru: arka plan görevi ve ekran aynı veriyi kullanır ----
const fresh = () => ({ t0: Date.now(), last: null, dist: 0, max: 0, movingMs: 0, acc: 0, brake: 0, corner: 0, stops: 0, maxG: 0, moved: false, stopped: false, lastEv: 0, route: [], left: 0, right: 0, maxDec: 0, maxAcc: 0, lastTurn: 0, turn: 0, latS: 0, aS: 0, stillSince: 0, kf: null, rej: 0, cdir: 0, csum: 0, cquiet: 0 });
let R = fresh();
let onTick = null;

const bearing = (a, b) => {
  const r = Math.PI / 180, dl = (b.longitude - a.longitude) * r;
  const y = Math.sin(dl) * Math.cos(b.latitude * r), x = Math.cos(a.latitude * r) * Math.sin(b.latitude * r) - Math.sin(a.latitude * r) * Math.cos(b.latitude * r) * Math.cos(dl);
  return ((Math.atan2(y, x) / r) + 360) % 360;
};
// Viraj sayımı: aynı yönde süren yön değişimi toplamı 30°'yi geçerse bir sol/sağ viraj sayılır
function finishCurve(d) { if (Math.abs(d.csum) >= 30) { if (d.csum > 0) d.right++; else d.left++; } d.csum = 0; d.cdir = 0; d.cquiet = 0; }
function curveStep(d, sd, dt) {
  const r = sd / dt;
  if (Math.abs(r) >= 1.5) {
    const dir = r > 0 ? 1 : -1;
    if (d.cdir && dir !== d.cdir) finishCurve(d);
    d.cdir = dir; d.csum += sd; d.cquiet = 0;
  } else { d.cquiet += dt; if (d.cquiet >= 2) finishCurve(d); }
}
function turnsFromRoute(route) {
  const d = { csum: 0, cdir: 0, cquiet: 0, left: 0, right: 0 };
  if (!route || route.length < 8) return d;
  let prev = null;
  for (let i = 3; i < route.length; i++) {
    const hd = bearing(route[i - 3], route[i]), v = Math.max((route[i].v || 30) / 3.6, 3);
    if (prev != null) curveStep(d, ((hd - prev + 540) % 360) - 180, 8 / v);
    prev = hd;
  }
  finishCurve(d);
  return d;
}
// GPS konumunu doğruluk bilgisine göre yumuşatır (Kalman)
function smooth(d, c, t, v) {
  const acc = Math.max(c.accuracy || 10, 3);
  if (!d.kf) { d.kf = { lat: c.latitude, lon: c.longitude, v: acc * acc, t }; return d.kf; }
  const k = d.kf, dt = Math.max(0, (t - k.t) / 1000);
  k.v += dt * Math.pow(Math.max(v, 2), 2);
  const g = k.v / (k.v + acc * acc);
  k.lat += g * (c.latitude - k.lat); k.lon += g * (c.longitude - k.lon); k.v *= 1 - g; k.t = t;
  return k;
}
function processLoc(loc) {
  const c = loc.coords, t = loc.timestamp, d = R;
  if (c.accuracy > 22) return;
  const dt = d.last ? (t - d.last.t) / 1000 : 0;
  const v = c.speed != null && c.speed >= 0 ? c.speed : dt > 0 ? Math.min((hav(d.last.c, c) * 1000) / dt, 80) : 0;
  if (d.last && d.kf) { // GPS sıçraması: mantıksız uzak nokta atılır
    const jump = hav({ latitude: d.kf.lat, longitude: d.kf.lon }, c) * 1000;
    if (dt > 0 && jump > (Math.max(v, d.last.v) + 3) * dt * 2 + c.accuracy + 15 && d.rej < 4) { d.rej++; return; }
  }
  d.rej = 0;
  const kf = smooth(d, c, t, v), pos = { latitude: kf.lat, longitude: kf.lon };
  const hd = c.heading >= 0 && v > 1.5 ? c.heading : d.last && v > 2 && hav(d.last.pos, pos) > 0.003 ? bearing(d.last.pos, pos) : -1;
  if (d.last && dt >= 0.5 && dt < 10) {
    if (v > 1) { d.dist += (((v + d.last.v) / 2) * dt) / 1000; d.movingMs += dt * 1000; }
    const a = Math.max(-12, Math.min(12, (v - d.last.v) / dt));
    let lat = 0, sd = 0;
    if (hd >= 0 && d.last.hd >= 0 && v > 2 && d.last.v > 2) { sd = ((hd - d.last.hd + 540) % 360) - 180; lat = v * (Math.abs(sd) * Math.PI / 180) / dt; }
    curveStep(d, sd, dt);
    d.latS = d.latS * 0.6 + lat * 0.4; d.aS = d.aS * 0.5 + a * 0.5;
    d.maxAcc = Math.max(d.maxAcc, Math.min(a, 8)); d.maxDec = Math.max(d.maxDec, Math.min(-a, 8));
    if (t - d.lastEv > 3000) {
      if (a > 2.5) { d.acc++; d.lastEv = t; }
      else if (a < -3) { d.brake++; d.lastEv = t; }
      else if (d.latS > 3) { d.corner++; d.lastEv = t; }
    }
    d.maxG = Math.max(d.maxG, Math.min(Math.sqrt(d.aS * d.aS + d.latS * d.latS) / G, 2.5));
  }
  if (v >= 2) { d.moved = true; d.stopped = false; d.stillSince = 0; }
  else if (v < 1) { if (!d.stillSince) d.stillSince = t; if (d.moved && !d.stopped && t - d.stillSince >= 4000) { d.stops++; d.stopped = true; } }
  if (v * 3.6 < 400 && v > 1) d.max = Math.max(d.max, v * 3.6);
  const lp = d.route[d.route.length - 1];
  const back = lp && v > 3 && c.heading >= 0 && angDiff(bearing(lp, pos), c.heading) > 100; // geri sapan titreşim noktaları atılır
  if ((!lp || (v > 2 && hav(lp, pos) > 0.008 && !back)) && d.route.length < 4000) d.route.push({ latitude: pos.latitude, longitude: pos.longitude, v: Math.round(v * 3.6) });
  d.last = { c, t, v, hd, pos };
  onTick && onTick();
}
// Rotayı yola oturtma (OpenStreetMap yol verisi, OSRM)
async function snapRoute(route) {
  if (!route || route.length < 5) return null;
  const step = Math.max(1, Math.ceil(route.length / 360)), pts = route.filter((_, i) => i % step === 0 || i === route.length - 1), out = [];
  for (let a = 0; a < pts.length - 1; a += 80) {
    const seg = pts.slice(a, Math.min(pts.length, a + 81));
    if (seg.length < 2) break;
    let got = null;
    try {
      const url = `https://router.project-osrm.org/match/v1/driving/${seg.map((p) => p.longitude.toFixed(5) + ',' + p.latitude.toFixed(5)).join(';')}?overview=full&geometries=geojson&gaps=ignore&tidy=true&radiuses=${seg.map(() => 30).join(';')}`;
      const j = await (await fetch(url)).json();
      if (j.code === 'Ok' && j.matchings && j.matchings.length) got = j.matchings.flatMap((m) => m.geometry.coordinates);
    } catch {}
    if (got && got.length > 1) got.forEach((g, i) => out.push({ latitude: g[1], longitude: g[0], v: seg[Math.min(seg.length - 1, Math.round((i / (got.length - 1)) * (seg.length - 1)))].v }));
    else seg.forEach((p) => out.push(p));
  }
  const k = Math.ceil(out.length / 3000);
  return out.length > 1 ? out.filter((_, i) => i % k === 0 || i === out.length - 1) : null;
}
Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
TaskManager.defineTask(TASK, ({ data, error }) => { if (!error && data?.locations) data.locations.forEach(processLoc); });
async function fetchLatest() {
  if (!GH_REPO) return null;
  const j = await (await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`)).json();
  const n = parseInt(String(j.tag_name).replace(/\D/g, ''), 10), apk = (j.assets || []).find((a) => a.name.endsWith('.apk'));
  return n > BUILD && apk ? { n, url: apk.browser_download_url, page: j.html_url } : null;
}
async function notifyUpdate() {
  try {
    const r = await fetchLatest();
    if (!r) return null;
    const last = parseInt((await AsyncStorage.getItem('@apexdrive_notified')) || '0', 10);
    if (r.n > last) {
      await AsyncStorage.setItem('@apexdrive_notified', String(r.n));
      await Notifications.scheduleNotificationAsync({ content: { title: 'ApexDrive yeni sürümü çıktı 🚀', body: 'Yeni özellikler hazır. Güncellemek ister misin?', data: { to: 'update' } }, trigger: null });
    }
    return r;
  } catch { return null; }
}
const UPD_TASK = 'apexdrive-update-check';
TaskManager.defineTask(UPD_TASK, async () => { await notifyUpdate(); return BackgroundTask.BackgroundTaskResult.Success; });

// ---- Yardımcılar: toplamlar ve sıralama sunucusu ----
const totals = (trips) => trips.reduce((a, t) => ({ dist: a.dist + t.dist, time: a.time + t.duration, still: a.still + (t.still || 0), n: a.n + 1, top: Math.max(a.top, t.max), left: a.left + (t.left || 0), right: a.right + (t.right || 0), brake: a.brake + t.brake, hacc: a.hacc + t.acc, dec: Math.max(a.dec, t.maxDec || 0), acc: Math.max(a.acc, t.maxAcc || 0), g: Math.max(a.g, t.maxG), stops: a.stops + t.stops }), { dist: 0, time: 0, still: 0, n: 0, top: 0, left: 0, right: 0, brake: 0, hacc: 0, dec: 0, acc: 0, g: 0, stops: 0 });
const fmtDur = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}sa ${m}dk` : `${m}dk`; };
const online = !!(SUPA_URL && SUPA_KEY);
const api = (path, opt = {}) => fetch(`${SUPA_URL}/rest/v1/${path}`, { ...opt, headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
const register = async (username, deviceId, car) => {
  if (!online) return 'ok';
  try {
    const r = await api('profiles', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ username, device_id: deviceId, car_brand: car.brand, car_model: car.model, car_year: car.year, vehicle_type: car.vtype }) });
    return r.status === 409 ? 'taken' : r.ok ? 'ok' : 'err';
  } catch { return 'err'; }
};
const ensureProfile = (p) => online && api('profiles?on_conflict=username', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ username: p.username, device_id: p.deviceId, car_brand: p.car?.brand, car_model: p.car?.model, car_year: p.car?.year, vehicle_type: p.car?.vtype }) }).catch(() => {});
const monthKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}`;
const syncProfile = (p, trips) => {
  if (!online) return;
  const tt = totals(trips), mk = monthKey(new Date()), car = p.car || {};
  const mkm = trips.filter((t) => monthKey(new Date(t.start)) === mk).reduce((a, t) => a + t.dist, 0);
  api(`profiles?username=eq.${encodeURIComponent(p.username)}&device_id=eq.${p.deviceId}`, { method: 'PATCH', body: JSON.stringify({ total_km: tt.dist, top_speed: tt.top, trips: tt.n, avg_speed: tt.time > tt.still ? tt.dist / ((tt.time - tt.still) / 3600) : 0, month_km: mkm, month_key: mk, car_brand: car.brand, car_model: car.model, car_year: car.year, vehicle_type: car.vtype }) }).catch(() => {});
};

// ---- Bileşenler ----
function Stat({ label, value, unit, color }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, color && { color }]}>{value}<Text style={s.unit}> {unit}</Text></Text>
    </View>
  );
}
const Grid = ({ children }) => <View style={s.grid}>{children}</View>;
const Card = ({ icon, color, label, value, unit, wide }) => (
  <View style={[s.card, wide && { flexBasis: '100%' }]}>
    <Ionicons name={icon} size={26} color={color} />
    <Text style={s.cLabel}>{label}</Text>
    <Text style={s.cValue}>{value}{unit ? <Text style={s.cUnit}> {unit}</Text> : null}</Text>
  </View>
);

function TripStats({ t }) {
  return (
    <Grid>
      <Card icon="navigate" color={C.accent} label="Mesafe" value={t.dist.toFixed(1)} unit="km" />
      <Card icon="time" color={C.warn} label="Süre" value={fmtTime(t.duration)} />
      <Card icon="flash" color="#FF453A" label="Maks. hız" value={Math.round(t.max)} unit="km/s" />
      <Card icon="speedometer" color="#34C759" label="Ort. hız" value={Math.round(Math.min(t.avg, t.max))} unit="km/s" />
      <Card icon="arrow-undo" color="#5B5BE0" label="Sol dönüş" value={t.left || 0} />
      <Card icon="arrow-redo" color="#FF2D55" label="Sağ dönüş" value={t.right || 0} />
      <Card icon="alert-circle" color="#E5575A" label="Fren" value={t.brake} />
      <Card icon="rocket" color={C.warn} label="Sert hızlanma" value={t.acc} />
      <Card icon="arrow-down-circle" color="#FF453A" label="Maks. yavaşlama" value={(t.maxDec || 0).toFixed(1)} unit="m/s²" />
      <Card icon="arrow-up-circle" color="#34C759" label="Maks. ivme" value={(t.maxAcc || 0).toFixed(1)} unit="m/s²" />
      <Card wide icon="speedometer-outline" color={C.warn} label="Tepe G-Kuvveti" value={t.maxG.toFixed(2)} unit="G" />
    </Grid>
  );
}

function Drive({ on, live, onStart, onStop }) {
  return (
    <View style={{ flex: 1, padding: 20, paddingBottom: 120 }}>
      <Text style={s.title}>Sürüş</Text>
      <View style={s.speedBox}>
        <Text style={s.speed}>{Math.round(live.speed)}</Text>
        <Text style={s.speedUnit}>km/s</Text>
      </View>
      <Grid>
        <Card icon="navigate" color={C.accent} label="Mesafe" value={live.dist.toFixed(2)} unit="km" />
        <Card icon="time" color={C.warn} label="Süre" value={fmtTime(live.secs)} />
        <Card icon="flash" color="#FF453A" label="Maks. hız" value={Math.round(live.max)} unit="km/s" />
        <Card icon="speedometer-outline" color={C.warn} label="Maks. G" value={live.g.toFixed(2)} unit="G" />
      </Grid>
      <TouchableOpacity style={[s.btn, on && { backgroundColor: '#FF6B6B' }]} onPress={on ? onStop : onStart}>
        <Text style={s.btnText}>{on ? 'Sürüşü bitir' : 'Sürüşü başlat'}</Text>
      </TouchableOpacity>
      <Text style={s.hint}>Sürerken telefonu kullanma. Trafik kurallarına uy.</Text>
    </View>
  );
}

const CAR_MAP = Object.fromEntries(`Alfa Romeo:Giulia,Giulietta,Stelvio,Tonale,MiTo;Audi:A1,A3,A4,A5,A6,Q2,Q3,Q5,Q7,TT,RS3,RS6;BMW:1 Serisi,2 Serisi,3 Serisi,4 Serisi,5 Serisi,X1,X3,X5,M2,M3,M4,M5;Chevrolet:Aveo,Cruze,Captiva,Camaro,Corvette;Citroën:C3,C4,C5,C-Elysée,Berlingo;Cupra:Formentor,Leon,Born;Dacia:Duster,Sandero,Logan,Jogger,Spring;Fiat:Egea,Linea,Punto,500,Doblo,Panda,Tipo;Ford:Fiesta,Focus,Mondeo,Kuga,Puma,Mustang,Ranger,Courier;Honda:Civic,City,Accord,Jazz,CR-V,HR-V;Hyundai:i10,i20,i30,Elantra,Bayon,Tucson,Kona,Ioniq 5;Jeep:Renegade,Compass,Wrangler,Cherokee;Kia:Picanto,Rio,Ceed,Sportage,Sorento,Stonic,EV6;Land Rover:Defender,Discovery,Evoque,Range Rover;Mazda:2,3,6,CX-3,CX-5,MX-5;Mercedes-Benz:A Serisi,C Serisi,E Serisi,S Serisi,CLA,GLA,GLC,AMG GT;Mini:Cooper,Countryman;Mitsubishi:Lancer,ASX,L200,Outlander;Nissan:Micra,Juke,Qashqai,X-Trail,GT-R,370Z;Opel:Corsa,Astra,Insignia,Mokka,Crossland,Grandland;Peugeot:208,301,308,408,508,2008,3008;Porsche:911,Cayenne,Macan,Panamera,Taycan;Renault:Clio,Megane,Taliant,Captur,Kadjar,Austral,Symbol,Fluence,Talisman,Koleos;Seat:Ibiza,Leon,Arona,Ateca;Škoda:Fabia,Scala,Octavia,Superb,Kamiq,Karoq,Kodiaq;Subaru:Impreza,WRX,Forester,XV;Suzuki:Swift,Vitara,SX4,Jimny;Tesla:Model 3,Model S,Model X,Model Y;Toyota:Yaris,Corolla,Auris,C-HR,RAV4,Hilux,Supra,GR86;Togg:T10X;Volkswagen:Polo,Golf,Passat,Jetta,Tiguan,T-Roc,Arteon,Scirocco;Volvo:S60,S90,V40,XC40,XC60,XC90`.split(';').map((x) => { const [b, m] = x.split(':'); return [b, m.split(',')]; }));
const BRANDS = Object.keys(CAR_MAP).sort((a, b) => a.localeCompare(b, 'tr'));
const YEARS = Array.from({ length: 48 }, (_, i) => String(2027 - i));
const MOTO_MAP = Object.fromEntries(`Aprilia:RS 660,Tuono 660,RSV4,Tuono V4;Benelli:TRK 502,Leoncino 500,302R;BMW:G 310 R,F 900 R,F 900 XR,R 1250 GS,R 1300 GS,S 1000 RR,S 1000 R;CFMOTO:250NK,450SR,650NK,800MT;Ducati:Monster,Panigale V2,Panigale V4,Multistrada V4,Streetfighter V4,Scrambler,Diavel;Harley-Davidson:Sportster S,Iron 883,Street Glide,Fat Boy,Road King;Honda:CBR250R,CBR500R,CBR650R,CBR1000RR,CB650R,CB125R,Africa Twin,PCX,Forza 350,Transalp;Husqvarna:Svartpilen 401,Vitpilen 401,Norden 901;Kawasaki:Ninja 250,Ninja 400,Ninja 650,ZX-6R,ZX-10R,Z650,Z900,Versys 650,Versys 1000;KTM:Duke 125,Duke 390,Duke 790,Duke 890,RC 390,390 Adventure,1290 Super Duke R;Kymco:Agility,Downtown,Xciting;Moto Guzzi:V7,V85 TT;MV Agusta:Brutale 800,F3;Royal Enfield:Classic 350,Himalayan,Interceptor 650,Continental GT 650,Meteor 350;Suzuki:GSX-R600,GSX-R750,GSX-R1000,GSX-S750,GSX-S1000,V-Strom 650,V-Strom 1050,Hayabusa,Burgman 400;SYM:Symphony,Joyride,Maxsym;Triumph:Street Triple,Speed Triple,Trident 660,Tiger 900,Tiger 1200,Bonneville T120,Daytona 660;Vespa:Primavera,GTS 300,Sprint;Yamaha:R25,R3,R6,R1,MT-03,MT-07,MT-09,Tracer 9,XMAX,NMAX,Tenere 700`.split(';').map((x) => { const [b, m] = x.split(':'); return [b, m.split(',')]; }));

function Picker({ title, options, onPick, onClose }) {
  const [q, setQ] = useState('');
  const t = q.trim(), list = options.filter((x) => x.toLowerCase().includes(t.toLowerCase()));
  const data = t && !options.some((x) => x.toLowerCase() === t.toLowerCase()) ? [t, ...list] : list;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <View style={{ padding: 20, flex: 1 }}>
          <Text style={s.title}>{title}</Text>
          <TextInput style={[s.input, { marginTop: 0, marginBottom: 12 }]} value={q} onChangeText={setQ} placeholder="Ara ya da listede yoksa kendin yaz" placeholderTextColor={C.dim} />
          <FlatList data={data} keyExtractor={(x) => x} keyboardShouldPersistTaps="handled" renderItem={({ item }) => (
            <TouchableOpacity style={s.item} onPress={() => onPick(item)}><Text style={s.itemTitle}>{item}</Text></TouchableOpacity>
          )} />
          <TouchableOpacity onPress={onClose}><Text style={{ color: C.accent, textAlign: 'center', padding: 12 }}>Kapat</Text></TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function Welcome({ existing, onDone }) {
  const [step, setStep] = useState(existing ? 1 : 0);
  const [name, setName] = useState('');
  const [vt, setVt] = useState('car');
  const [car, setCar] = useState({ brand: '', model: '', year: '' });
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const map = vt === 'moto' ? MOTO_MAP : CAR_MAP;
  const next = () => {
    if (!/^[a-z0-9_.]{3,20}$/.test(name.trim().toLowerCase())) return AlertX.alert('Geçersiz kullanıcı adı', '3-20 karakter olmalı; harf, rakam, _ ve . kullanabilirsin.');
    setStep(1);
  };
  const go = async () => {
    if (!car.brand || !car.model || !car.year) return AlertX.alert('Eksik bilgi', 'Marka, model ve yılı seç.');
    const c = { brand: car.brand, model: car.model, year: +car.year, vtype: vt };
    if (existing) return onDone({ ...existing, car: c });
    const u = name.trim().toLowerCase();
    setBusy(true);
    const deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const res = await register(u, deviceId, c);
    setBusy(false);
    if (res === 'taken') { setStep(0); return AlertX.alert('Bu kullanıcı adı alınmış', 'Başka bir tane dene.'); }
    if (res === 'err') return AlertX.alert('Bağlanılamadı', 'İnternet bağlantını kontrol edip tekrar dene.');
    onDone({ username: u, deviceId, car: c });
  };
  const Field = ({ label, value, onPress, off }) => (
    <TouchableOpacity style={[s.input, off && { opacity: 0.4 }]} onPress={off ? undefined : onPress}>
      <Text style={{ color: value ? C.text : C.dim, fontSize: 17 }}>{value || label}</Text>
    </TouchableOpacity>
  );
  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 40 }} keyboardShouldPersistTaps="handled">
      <Image source={require('./icon.png')} style={s.logo} />
      {step === 0 && (
        <View>
          <Text style={s.title}>ApexDrive'a hoş geldin</Text>
          <Text style={s.itemSub}>Önce bir kullanıcı adı seç.</Text>
          <TextInput style={s.input} value={name} onChangeText={setName} placeholder="kullanıcı adı" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false} maxLength={20} />
          <TouchableOpacity style={s.btn} onPress={next}><Text style={s.btnText}>Devam</Text></TouchableOpacity>
        </View>
      )}
      {step === 1 && (
        <View>
          <Text style={s.title}>Ne sürüyorsun?</Text>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
            {[['car', 'Araba'], ['moto', 'Motor']].map(([k, l]) => (
              <TouchableOpacity key={k} style={[s.card, { alignItems: 'center', paddingVertical: 32 }, vt === k && { borderWidth: 2, borderColor: C.accent }]} onPress={() => { setVt(k); setCar({ brand: '', model: '', year: car.year }); setStep(2); }}>
                {k === 'moto' ? <MaterialCommunityIcons name="motorbike" size={52} color={C.accent} /> : <Ionicons name="car-sport" size={52} color={C.accent} />}
                <Text style={[s.itemTitle, { marginTop: 10 }]}>{l}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}
      {step === 2 && (
        <View>
          <Text style={s.title}>{vt === 'moto' ? 'Motorunu seç' : 'Aracını seç'}</Text>
          <Field label="Marka" value={car.brand} onPress={() => setPick('brand')} />
          <Field label="Model" value={car.model} off={!car.brand} onPress={() => setPick('model')} />
          <Field label="Yıl" value={car.year} onPress={() => setPick('year')} />
          <TouchableOpacity style={s.btn} onPress={go} disabled={busy}><Text style={s.btnText}>{busy ? 'Kontrol ediliyor...' : 'Başla'}</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setStep(1)}><Text style={{ color: C.accent, textAlign: 'center', padding: 14 }}>Geri</Text></TouchableOpacity>
        </View>
      )}
      {pick && (
        <Picker
          title={{ brand: 'Marka', model: 'Model', year: 'Yıl' }[pick]}
          options={pick === 'brand' ? Object.keys(map).sort((a, b) => a.localeCompare(b, 'tr')) : pick === 'model' ? map[car.brand] || [] : YEARS}
          onClose={() => setPick(null)}
          onPick={(v) => { setCar(pick === 'brand' ? { brand: v, model: '', year: car.year } : { ...car, [pick]: v }); setPick(null); }}
        />
      )}
    </ScrollView>
  );
}

// ---- Bölge (altıgen) hesabı ----
const EMPTY = [];
const hexKey = (lat, lon) => {
  const x = 6378137 * lon * Math.PI / 180, y = 6378137 * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const q = (Math.sqrt(3) / 3 * x - y / 3) / 500, r = (2 / 3 * y) / 500;
  let rx = Math.round(q), ry = Math.round(-q - r), rz = Math.round(r);
  const dx = Math.abs(rx - q), dy = Math.abs(ry + q + r), dz = Math.abs(rz - r);
  if (dx > dy && dx > dz) rx = -ry - rz; else if (dy <= dz) rz = -rx - ry;
  return rx + ':' + rz;
};
const cellsOf = (routes) => { const st = new Set(); routes.forEach((rt) => rt.forEach((p) => st.add(hexKey(p.latitude, p.longitude)))); return [...st]; };

const BUCKETS = [['<50', '#4FD1C5', 0, 50], ['50-90', '#34C759', 50, 90], ['90-120', '#FF9500', 90, 120], ['120+', '#FF453A', 120, 999]];
function SpeedDist({ route }) {
  const pts = (route || []).filter((p) => p.v != null);
  if (pts.length < 2) return null;
  const pc = BUCKETS.map(([, , lo, hi]) => (pts.filter((p) => p.v >= lo && p.v < hi).length / pts.length) * 100);
  return (
    <View style={[s.card, { marginBottom: 12 }]}>
      <Text style={s.cLabel}>HIZ DAĞILIMI (km/s)</Text>
      <View style={[s.bar, { height: 8, borderRadius: 4 }]}>{BUCKETS.map((b, i) => <View key={i} style={{ flex: Math.max(pc[i], 0.001), backgroundColor: b[1] }} />)}</View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
        {BUCKETS.map((b, i) => <View key={i}><Text style={[s.itemSub, { color: b[1] }]}>● {b[0]}</Text><Text style={s.itemTitle}>{Math.round(pc[i])}%</Text></View>)}
      </View>
    </View>
  );
}

function MonthChart({ trips }) {
  const now = new Date(), months = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push({ k: d.getFullYear() * 12 + d.getMonth(), label: d.toLocaleString('tr-TR', { month: 'short' }), v: 0, n: 0 }); }
  trips.forEach((t) => { const d = new Date(t.start), m = months.find((x) => x.k === d.getFullYear() * 12 + d.getMonth()); if (m) { m.v += t.dist; m.n++; } });
  const cur = months[5], prev = months[4].v, pct = prev > 0 ? ((cur.v - prev) / prev) * 100 : null;
  const W = 300, H = 90, max = Math.max(...months.map((m) => m.v), 1);
  const pts = months.map((m, i) => [(i / 5) * W, H - (m.v / max) * (H - 10) - 5]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return (
    <View style={[s.card, { flexBasis: '100%' }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={s.itemSub}>Bu Ay</Text>
        {pct != null && <Text style={{ color: pct >= 0 ? '#34C759' : '#FF453A', fontWeight: '700' }}>{pct >= 0 ? '↗' : '↘'} {Math.abs(Math.round(pct))}% geçen aya göre</Text>}
      </View>
      <Text style={s.cValue}>{cur.v.toFixed(1)}<Text style={s.cUnit}> km · {cur.n} sürüş</Text></Text>
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ marginTop: 14 }}>
        <Path d={`${line} L${W} ${H} L0 ${H} Z`} fill="#34C75922" />
        <Path d={line} stroke="#34C759" strokeWidth={3} fill="none" />
      </Svg>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>{months.map((m) => <Text key={m.k} style={s.itemSub}>{m.label}</Text>)}</View>
    </View>
  );
}

const METRICS = [['total_km', 'Toplam km', 'km'], ['top_speed', 'Top Speed', 'km/s'], ['avg_speed', 'Ort. Hız', 'km/s']];
function Board({ me, friends, addFriend }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [mi, setMi] = useState(0);
  const [type, setType] = useState('month');
  const [fr, setFr] = useState(false);
  const [name, setName] = useState('');
  const load = async () => {
    if (!online) return;
    setBusy(true);
    try { const r = await api('profiles?select=username,total_km,top_speed,avg_speed,trips,month_km,month_key,car_brand,car_model,car_year&limit=500'); const j = await r.json(); setRows(Array.isArray(j) ? j : []); } catch { setRows([]); }
    setBusy(false);
  };
  useEffect(() => { load(); }, []);
  if (!online) return <View style={{ flex: 1, padding: 20 }}><Text style={s.title}>Sıralama</Text><Text style={s.itemSub}>Sıralama sunucusu henüz bağlanmadı.</Text></View>;
  const mk = type === 'month' ? 'month_km' : METRICS[mi][0], mu = mk.endsWith('km') ? 'km' : 'km/s', nk = monthKey(new Date()), car = me.car || {};
  const list = rows.filter((r) => (type === 'month' ? r.month_key === nk : r.car_brand === car.brand && r.car_model === car.model) && (!fr || r.username === me.username || friends.includes(r.username))).sort((a, b) => (b[mk] || 0) - (a[mk] || 0));
  const val = (r) => (mk.endsWith('km') ? (r.total_km || 0).toFixed(1) : Math.round(r[mk] || 0));
  const Pod = ({ r, n, h }) => !r ? <View style={{ flex: 1 }} /> : (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
      {n === 1 && <Ionicons name="trophy" size={22} color="#FFD60A" />}
      <View style={[s.pAv, n === 1 && { width: 72, height: 72, borderRadius: 36, borderColor: '#FFD60A' }]}><Text style={s.pLetter}>{r.username[0].toUpperCase()}</Text></View>
      <Text style={s.itemTitle} numberOfLines={1}>{r.username}</Text>
      <Text style={{ color: n === 1 ? '#FFD60A' : C.text, fontWeight: '700' }}>{val(r)} <Text style={s.itemSub}>{mu}</Text></Text>
      <View style={[s.pBlock, { height: h, borderColor: n === 1 ? '#FFD60A' : C.line }]}><Text style={[s.rank, { width: undefined, color: n === 1 ? '#FFD60A' : C.text }]}>{n}</Text></View>
    </View>
  );
  return (
    <FlatList
      data={list.slice(3)}
      keyExtractor={(r) => r.username}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={C.accent} />}
      contentContainerStyle={{ padding: 20, paddingBottom: 120 }}
      ListHeaderComponent={
        <View>
          <Text style={s.title}>TripRank</Text>
          <View style={[s.seg, { position: 'relative', top: 0, alignSelf: 'flex-start', marginBottom: 14 }]}>
            {[['month', 'Km'], ['car', 'Araç']].map(([k, l]) => (
              <TouchableOpacity key={k} style={[s.segBtn, { paddingHorizontal: 20 }, type === k && s.segActive]} onPress={() => setType(k)}><Text style={[s.segText, type === k && { color: C.text }]}>{l}</Text></TouchableOpacity>
            ))}
          </View>
          {type === 'month' && <Text style={[s.itemSub, { marginBottom: 12 }]}>Bu ayın toplam km sıralaması</Text>}
          {type === 'car' && <Text style={[s.itemSub, { marginBottom: 12 }]}>{car.brand} {car.model} kullananlar</Text>}
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
            <TouchableOpacity style={s.fpill} onPress={() => setFr(!fr)}><Ionicons name="people" size={16} color={C.text} /><Text style={s.navText}>{fr ? 'Arkadaşlar' : 'Herkes'}</Text></TouchableOpacity>
            {type === 'car' && <TouchableOpacity style={s.fpill} onPress={() => setMi((mi + 1) % 3)}><Ionicons name="stats-chart" size={16} color={C.text} /><Text style={s.navText}>{METRICS[mi][1]}</Text></TouchableOpacity>}
          </View>
          {fr && (
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
              <TextInput style={[s.input, { flex: 1, marginTop: 0, padding: 12 }]} value={name} onChangeText={setName} placeholder="arkadaş kullanıcı adı" placeholderTextColor={C.dim} autoCapitalize="none" />
              <TouchableOpacity style={[s.fpill, { backgroundColor: C.accent }]} onPress={() => { if (name.trim()) { addFriend(name.trim().toLowerCase()); setName(''); } }}><Text style={[s.navText, { color: '#06101F' }]}>Ekle</Text></TouchableOpacity>
            </View>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 16 }}>
            <Pod r={list[1]} n={2} h={64} /><Pod r={list[0]} n={1} h={92} /><Pod r={list[2]} n={3} h={48} />
          </View>
        </View>
      }
      ListEmptyComponent={list.length ? null : <Text style={s.hint}>{type === 'car' ? 'Aynı aracı kullanan kimse yok.' : 'Bu ay henüz kimse sürmedi.'}</Text>}
      renderItem={({ item, index }) => (
        <View style={[s.item, { flexDirection: 'row', alignItems: 'center' }, item.username === me.username && { borderWidth: 1, borderColor: C.accent }]}>
          <Text style={s.rank}>{index + 4}</Text>
          <View style={[s.pAv, { width: 40, height: 40, borderRadius: 20, marginRight: 12 }]}><Text style={s.pLetter}>{item.username[0].toUpperCase()}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.itemTitle}>{item.username}</Text>
            <Text style={s.itemSub}>{item.car_brand ? `${item.car_brand} ${item.car_model} ${item.car_year || ''} · ` : ''}{item.trips} sürüş</Text>
          </View>
          <Text style={s.itemTitle}>{val(item)} <Text style={s.itemSub}>{mu}</Text></Text>
        </View>
      )}
    />
  );
}

function Profile({ me, trips, terr, onSettings, onUpdate, onAvatar, onDelete }) {
  const [sel, setSel] = useState(null);
  if (sel) return <Detail t={trips.find((x) => x.id === sel.id) || sel} onBack={() => setSel(null)} onDelete={() => { onDelete(sel.id); setSel(null); }} onUpdate={onUpdate} />;
  const tt = totals(trips);
  const lp = tt.left + tt.right ? (tt.left / (tt.left + tt.right)) * 100 : 50;
  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}><Text style={s.title}>Profil</Text><TouchableOpacity onPress={onSettings} style={{ padding: 6 }}><Ionicons name="settings-outline" size={26} color={C.text} /></TouchableOpacity></View>
      <View style={[s.row, { alignItems: 'center' }]}>
        <TouchableOpacity onPress={onAvatar}>
          {me.avatar ? <Image style={s.avatar} source={{ uri: me.avatar }} /> : <View style={[s.avatar, { alignItems: 'center', justifyContent: 'center' }]}><Ionicons name="camera" size={28} color={C.dim} /></View>}
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.name}>{me.username}</Text>
          <Text style={s.itemSub}>{me.car ? `${me.car.brand} ${me.car.model} · ${me.car.year}` : ''}</Text>
        </View>
      </View>
      <Grid>
        <MonthChart trips={trips} />
        <Card icon="navigate" color={C.accent} label="Toplam Mesafe" value={tt.dist.toFixed(1)} unit="km" />
        <Card icon="time" color={C.warn} label="Toplam Süre" value={fmtDur(tt.time)} />
        <Card icon="pause-circle" color="#BF5AF2" label="Durma Süresi" value={fmtDur(tt.still)} />
        <Card icon="layers" color="#34C759" label="Toplam Trip" value={tt.n} />
        <Card wide icon="flash" color="#FF453A" label="Top Speed" value={Math.round(tt.top)} unit="km/h" />
      </Grid>
      <Text style={s.sec}>Manevralar</Text>
      <Grid>
        <Card icon="arrow-undo" color="#5B5BE0" label="Sol Dönüşler" value={tt.left} />
        <Card icon="arrow-redo" color="#FF2D55" label="Sağ Dönüşler" value={tt.right} />
        <Card icon="alert-circle" color="#E5575A" label="Fren Olayları" value={tt.brake} />
        <Card icon="rocket" color={C.warn} label="Sert Hızlanma" value={tt.hacc} />
        <View style={[s.card, { flexBasis: '100%' }]}>
          <Text style={s.itemTitle}>Dönüş Tercihi</Text>
          <View style={s.bar}>
            <View style={{ flex: Math.max(lp, 0.001), backgroundColor: '#5B5BE0', justifyContent: 'center', alignItems: 'center' }}><Text style={s.barText}>{lp.toFixed(1)}%</Text></View>
            <View style={{ flex: Math.max(100 - lp, 0.001), backgroundColor: '#FF2D55', justifyContent: 'center', alignItems: 'center' }}><Text style={s.barText}>{(100 - lp).toFixed(1)}%</Text></View>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}><Text style={s.itemSub}>Sol</Text><Text style={s.itemSub}>Sağ</Text></View>
        </View>
        <Card icon="arrow-down-circle" color="#FF453A" label="Maks. Yavaşlama" value={tt.dec.toFixed(1)} unit="m/s²" />
        <Card icon="arrow-up-circle" color="#34C759" label="Maks. İvme" value={tt.acc.toFixed(1)} unit="m/s²" />
        <Card wide icon="speedometer-outline" color={C.warn} label="Tepe G-Kuvveti" value={tt.g.toFixed(2)} unit="G" />
      </Grid>
      <Text style={s.sec}>Daha Fazla İstatistik</Text>
      <Grid>
        <Card icon="stop-circle" color={C.dim} label="Toplam Durak" value={tt.stops} />
        <Card icon="swap-horizontal" color={C.dim} label="Ort. Trip Uzunluğu" value={(tt.n ? tt.dist / tt.n : 0).toFixed(1)} unit="km" />
        <Card wide icon="map" color="#BF5AF2" label="Ele Geçirilen Bölge" value={terr} />
      </Grid>
            <Text style={s.sec}>Sürüşlerim</Text>
      {trips.length === 0 && <Text style={s.hint}>Henüz sürüş yok. Sağ alttaki oynat tuşuyla başlat.</Text>}
      {trips.map((t) => (
        <TouchableOpacity key={t.id} style={s.item} onPress={() => setSel(t)}>
          <Text style={s.itemTitle}>{fmtDate(t.start)}</Text>
          <Text style={s.itemSub}>{t.dist.toFixed(1)} km • {fmtTime(t.duration)} • maks. {Math.round(t.max)} km/s</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// Harita: OpenStreetMap verisi (Leaflet + CARTO karanlık katman). API anahtarı gerekmez.
const leafletHtml = (interactive) => `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#m{margin:0;height:100%;background:#000}.leaflet-control-attribution{font-size:9px}</style></head><body><div id="m"></div><script>
var map=L.map('m',{zoomControl:false,dragging:${interactive},touchZoom:${interactive},doubleClickZoom:${interactive},scrollWheelZoom:false,boxZoom:false,keyboard:false}).setView([39,35],5);
var E='https://services.arcgisonline.com/ArcGIS/rest/services/';
var dk=L.layerGroup([L.tileLayer(E+'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:16,maxZoom:19,attribution:'Esri'}),L.tileLayer(E+'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:16,maxZoom:19})]).addTo(map);
var st=L.layerGroup([L.tileLayer(E+'World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:19,maxZoom:19,attribution:'Esri'}),L.tileLayer(E+'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:19,maxZoom:19})]);
window.setSat=function(on){if(on){map.removeLayer(dk);st.addTo(map);}else{map.removeLayer(st);dk.addTo(map);}};
var grp=L.layerGroup().addTo(map),cg=L.layerGroup().addTo(map),gg=L.layerGroup().addTo(map),pts=[],me=null,S=500,R=6378137,ks=[],gridOn=false;
function col(v){return v==null?'#6EC7C7':v<50?'#4FD1C5':v<90?'#34C759':v<120?'#FF9500':'#FF453A';}
function inv(x,y){return [(2*Math.atan(Math.exp(y/R))-Math.PI/2)*180/Math.PI,x/R*180/Math.PI];}
map.on('dragend',function(){var c=map.getCenter();window.ReactNativeWebView.postMessage(JSON.stringify({lat:c.lat,lng:c.lng}));});
window.setRoute=function(p){grp.clearLayers();pts=p;if(p.length<2)return;var cur=[[p[0][0],p[0][1]]],c=col(p[1][2]);
for(var i=1;i<p.length;i++){var k=col(p[i][2]);if(k!==c){L.polyline(cur,{color:c,weight:5}).addTo(grp);cur=[cur[cur.length-1]];c=k;}cur.push([p[i][0],p[i][1]]);}
L.polyline(cur,{color:c,weight:5}).addTo(grp);};
function px(la,lo){return [R*lo*Math.PI/180,R*Math.log(Math.tan(Math.PI/4+la*Math.PI/360))];}
function hexPoly(q,r){var cx=S*Math.sqrt(3)*(q+r/2),cy=S*1.5*r,c=[];for(var i=0;i<6;i++){var t=(60*i-30)*Math.PI/180;c.push(inv(cx+S*Math.cos(t),cy+S*Math.sin(t)));}return c;}
function draw(){cg.clearLayers();gg.clearLayers();var set={};
ks.forEach(function(k){set[k]=1;var a=k.split(':');L.polygon(hexPoly(+a[0],+a[1]),{color:'#7DD3D8',weight:1.5,fillColor:'#2F8F93',fillOpacity:.5}).addTo(cg);});
if(gridOn&&map.getZoom()>=12){var b=map.getBounds(),p1=px(b.getSouth(),b.getWest()),p2=px(b.getNorth(),b.getEast()),r0=Math.floor(p1[1]/(S*1.5))-1,r1=Math.ceil(p2[1]/(S*1.5))+1;
for(var r=r0;r<=r1;r++){var q0=Math.floor(p1[0]/(S*Math.sqrt(3))-r/2)-1,q1=Math.ceil(p2[0]/(S*Math.sqrt(3))-r/2)+1;
for(var q=q0;q<=q1;q++){if(!set[q+':'+r])L.polygon(hexPoly(q,r),{color:'#7DD3D8',weight:1,opacity:.35,fill:false,interactive:false}).addTo(gg);}}}}
map.on('moveend',function(){if(gridOn)draw();});
window.setCells=function(a,g){ks=a;gridOn=!!g;draw();};
var rI=0,rT=null,rM=null,rR=4,pg=L.layerGroup().addTo(map);
function post(o){window.ReactNativeWebView.postMessage(JSON.stringify(o));}
window.rpPause=function(){clearInterval(rT);rT=null;};
window.rpRate=function(r){rR=r;};
window.rpPlay=function(r){rR=r;if(rT||pts.length<2)return;if(rI>=pts.length-1)rI=0;
if(!rM)rM=L.circleMarker([pts[0][0],pts[0][1]],{radius:9,color:'#fff',weight:3,fillColor:'#FF2D55',fillOpacity:1}).addTo(map);
map.setView([pts[Math.floor(rI)][0],pts[Math.floor(rI)][1]],16,{animate:false});var n=0;
rT=setInterval(function(){var p=pts[Math.floor(rI)],v=Math.max(p[2]||40,15);rI+=v/3.6/10*0.06*rR;
if(rI>=pts.length-1){rI=pts.length-1;window.rpPause();post({t:'end',i:rI,n:pts.length});}
p=pts[Math.floor(rI)];rM.setLatLng([p[0],p[1]]);map.setView([p[0],p[1]],map.getZoom(),{animate:false});
if(++n%4===0)post({t:'tick',i:Math.floor(rI),n:pts.length,v:p[2]});},60);};
window.setPeople=function(a){pg.clearLayers();a.forEach(function(p){
var ic=L.divIcon({className:'',html:'<div style="width:38px;height:38px;border-radius:19px;background:#1C1C21;border:3px solid '+(p.s?'#FF2D55':'#6EC7C7')+';color:#fff;font:700 15px sans-serif;display:flex;align-items:center;justify-content:center">'+p.u[0].toUpperCase()+'</div>',iconSize:[38,38]});
L.marker([p.lat,p.lon],{icon:ic}).on('click',function(){post({t:'person',u:p.u});}).addTo(pg);});};
window.fit=function(){if(pts.length>1)map.fitBounds(L.latLngBounds(pts.map(function(q){return [q[0],q[1]];})),{padding:[30,30],animate:false});};
window.setMe=function(la,lo,go){var ll=[la,lo];if(!me)me=L.circleMarker(ll,{radius:8,color:'#fff',weight:3,fillColor:'#6EC7C7',fillOpacity:1}).addTo(map);else me.setLatLng(ll);if(go)map.setView(ll,Math.max(map.getZoom(),15),{animate:true});};
</script></body></html>`;

function LeafletMap({ route, cells, grid, sat, people, cmd, onTick, onPerson, me, follow, fit, interactive = true, onMove, style }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const html = useRef(leafletHtml(interactive)).current;
  const run = (js) => ref.current?.injectJavaScript(js + ';true;');
  useEffect(() => {
    if (!ready) return;
    run(`setRoute(${JSON.stringify((route || []).map((p) => [p.latitude, p.longitude, p.v]))})`);
    if (fit) run('fit()');
  }, [ready, route]);
  useEffect(() => { if (ready) run(`setCells(${JSON.stringify(cells || [])},${!!grid})`); }, [ready, cells, grid]);
  useEffect(() => { if (ready) run(`setSat(${!!sat})`); }, [ready, sat]);
  useEffect(() => { if (ready) run(`setPeople(${JSON.stringify(people || [])})`); }, [ready, people]);
  useEffect(() => { if (ready && cmd) run(cmd.js); }, [cmd]);
  useEffect(() => { if (ready && me) run(`setMe(${me.latitude},${me.longitude},${!!follow})`); }, [ready, me, follow]);
  return (
    <WebView
      ref={ref}
      style={style}
      originWhitelist={['*']}
      source={{ html, baseUrl: 'https://apexdrive.app' }}
      onLoadEnd={() => setReady(true)}
      onMessage={(e) => { try { const m = JSON.parse(e.nativeEvent.data); if (m.t === 'person') onPerson && onPerson(m.u); else if (m.t) onTick && onTick(m); else onMove && onMove(m.lat, m.lng); } catch {} }}
      scrollEnabled={false}
      nestedScrollEnabled
      overScrollMode="never"
    />
  );
}

function PhotosView({ regions, cur, pickPhoto, delPhoto }) {
  const [view, setView] = useState(null);
  const list = Object.entries(regions).map(([k, r]) => ({ k, name: r.name, photos: r.photos || (r.photo ? [r.photo] : []) }))
    .filter((r) => r.photos.length || r.k === cur?.key).sort((a, b) => (b.k === cur?.key) - (a.k === cur?.key));
  const ask = (k, u) => AlertX.alert('Fotoğraf silinsin mi?', 'Bu işlem geri alınamaz.', [{ text: 'Vazgeç', style: 'cancel' }, { text: 'Sil', style: 'destructive', onPress: () => delPhoto(k, u) }]);
  const vp = view ? (list.find((x) => x.k === view.k) || { photos: [] }).photos : [];
  return (
    <ScrollView style={[StyleSheet.absoluteFill, { backgroundColor: C.bg }]} contentContainerStyle={{ padding: 20, paddingTop: 70, paddingBottom: 120 }}>
      {list.length === 0 && <Text style={s.hint}>Haritada gezindikçe bölgeler burada görünür.</Text>}
      {list.map((r) => (
        <View key={r.k} style={{ marginBottom: 22 }}>
          <Text style={s.sec}>{r.name}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {r.photos.map((u, i) => (
              <TouchableOpacity key={u} style={s.gph} onPress={() => setView({ k: r.k, i })} onLongPress={() => ask(r.k, u)}>
                <Image source={{ uri: u }} style={{ width: '100%', height: '100%', borderRadius: 16 }} />
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[s.gph, { alignItems: 'center', justifyContent: 'center', backgroundColor: C.card, borderRadius: 16 }]} onPress={() => pickPhoto(r.k)}><Ionicons name="add" size={32} color={C.accent} /></TouchableOpacity>
          </View>
        </View>
      ))}
      {view && <PhotoViewer photos={vp} start={view.i} onClose={() => setView(null)} onDelete={(u) => ask(view.k, u)} />}
    </ScrollView>
  );
}

function MapTab({ route, cells, on, region, regions, name, profile, pickPhoto, delPhoto, onPan }) {
  const [me, setMe] = useState(null);
  const [seen, setSeen] = useState(false);
  const [mode, setMode] = useState('cells');
  const [sat, setSat] = useState(false);
  const [people, setPeople] = useState([]), [person, setPerson] = useState(null), [composer, setComposer] = useState(false), [myst, setMyst] = useState(false);
  useEffect(() => {
    if (mode !== 'stories' || !online || !me) return;
    const load = async () => {
      try {
        const b = `lat=gte.${me.latitude - 0.5}&lat=lte.${me.latitude + 0.5}&lon=gte.${me.longitude - 0.5}&lon=lte.${me.longitude + 0.5}`;
        const pr = await (await api(`presence?${b}&updated_at=gte.${new Date(Date.now() - 900000).toISOString()}&select=username,lat,lon`)).json();
        const st = await (await api(`stories?${b}&created_at=gte.${new Date(Date.now() - 864e5).toISOString()}&select=username,lat,lon`)).json();
        const m = {};
        (Array.isArray(pr) ? pr : []).forEach((p) => { m[p.username] = { u: p.username, lat: p.lat, lon: p.lon, s: 0 }; });
        (Array.isArray(st) ? st : []).forEach((p) => { m[p.username] = { ...(m[p.username] || { u: p.username, lat: p.lat, lon: p.lon }), s: 1 }; });
        setPeople(Object.values(m));
      } catch {}
    };
    load(); const id = setInterval(load, 30000); return () => clearInterval(id);
  }, [mode, !!me]);
  useEffect(() => {
    let sub;
    Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 10 }, (l) => setMe({ latitude: l.coords.latitude, longitude: l.coords.longitude }))
      .then((x) => { sub = x; }).catch(() => {});
    return () => sub?.remove();
  }, []);
  useEffect(() => { if (me && !seen) { setSeen(true); onPan(me.latitude, me.longitude); } }, [me]);
  return (
    <View style={s.map}>
      <LeafletMap style={s.map} route={mode === 'route' ? route : EMPTY} cells={mode === 'cells' ? cells : EMPTY} me={me} follow={on || !seen} grid={mode === 'cells'} sat={sat} people={mode === 'stories' ? people : EMPTY} onPerson={setPerson} />
      {mode === 'photos' && <PhotosView regions={regions} cur={region} pickPhoto={pickPhoto} delPhoto={delPhoto} />}
      <View style={s.seg}>
        {[['route', 'Rota'], ['cells', 'Bölgelerim'], ['photos', 'Fotoğraflarım'], ['stories', 'Hikayeler']].map(([k, l]) => (
          <TouchableOpacity key={k} style={[s.segBtn, mode === k && s.segActive]} onPress={() => setMode(k)}>
            <Text style={[s.segText, mode === k && { color: C.text }]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {mode === 'stories' && (online ? (
        <View style={s.stBar}>
          <TouchableOpacity style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }} onPress={() => setMyst(true)}><Ionicons name="albums" size={22} color={C.accent} /><Text style={s.itemTitle}>Hikayelerim</Text></TouchableOpacity>
          <TouchableOpacity style={s.stAdd} onPress={() => (me ? setComposer(true) : AlertX.alert('Konum bulunamadı', 'Konum izni verip biraz bekle.'))}><Ionicons name="add" size={20} color="#06101F" /><Text style={s.btnText}>Ekle</Text></TouchableOpacity>
        </View>
      ) : <View style={s.terr}><Text style={s.itemSub}>Hikayeler için sunucu bağlantısı gerekli.</Text></View>)}
      {person && <PersonSheet u={person} me={profile} onClose={() => setPerson(null)} />}
      {myst && <MyStories me={profile} onClose={() => setMyst(false)} onAdd={() => { setMyst(false); setComposer(true); }} />}
      {composer && <StoryComposer me={profile} pos={me} onClose={() => setComposer(false)} />}
      {mode !== 'photos' && <TouchableOpacity style={s.satBtn} onPress={() => setSat(!sat)}><Ionicons name={sat ? 'map' : 'earth'} size={22} color={C.text} /></TouchableOpacity>}
      {region && mode !== 'photos' && mode !== 'stories' && (
        <TouchableOpacity style={s.chip} onPress={() => pickPhoto(region.key)}>
          {region.photo ? <Image source={{ uri: region.photo }} style={s.thumb} /> : <View style={s.thumb} />}
          <View style={{ flex: 1 }}>
            <Text style={s.itemTitle}>{region.name}</Text>
            <Text style={s.itemSub}>Fotoğraf ekle</Text>
          </View>
        </TouchableOpacity>
      )}
      {mode === 'cells' && (
        <View style={s.terr}>
          <View style={s.tav}><Text style={s.tavT}>{name.slice(0, 2).toUpperCase()}</Text></View>
          <Text style={s.tname}>{name.toUpperCase()}</Text>
          <Text style={s.tkm}>{(cells.length * 2.598 * Math.pow(0.5 * Math.cos(((me?.latitude ?? 40) * Math.PI) / 180), 2)).toFixed(1)} km²</Text>
        </View>
      )}
    </View>
  );
}

const spColor = (v) => (v == null ? '#fff' : v < 50 ? '#4FD1C5' : v < 90 ? '#34C759' : v < 120 ? '#FF9500' : '#FF453A');
function RouteSvg({ route, w, h, rs = 0, color = '#fff' }) {
  if (!route || route.length < 2) return null;
  const k = Math.cos(route[0].latitude * Math.PI / 180);
  const step = Math.ceil(route.length / 300), pts = route.filter((_, i) => i % step === 0 || i === route.length - 1);
  const xs = pts.map((p) => p.longitude * k), ys = pts.map((p) => -p.latitude);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), dx = Math.max(...xs) - x0 || 1e-9, dy = Math.max(...ys) - y0 || 1e-9;
  const sc = Math.min((w - 24) / dx, (h - 24) / dy), ox = (w - dx * sc) / 2, oy = (h - dy * sc) / 2;
  const P = pts.map((_, i) => [ox + (xs[i] - x0) * sc, oy + (ys[i] - y0) * sc]);
  const d = (a) => a.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const full = d(P), cm = { fill: 'none', strokeLinejoin: 'round', strokeLinecap: 'round' };
  let body;
  if (rs === 3) {
    const runs = []; let cur = [P[0]], c = spColor(pts[1].v);
    for (let i = 1; i < P.length; i++) { const kk = spColor(pts[i].v); if (kk !== c) { runs.push([cur, c]); cur = [P[i - 1]]; c = kk; } cur.push(P[i]); }
    runs.push([cur, c]);
    body = runs.map(([r, cc], i) => <Path key={i} d={d(r)} stroke={cc} strokeWidth={5} {...cm} />);
  } else if (rs === 1) {
    body = [<Path key="a" d={full} stroke={color} strokeWidth={16} opacity={0.18} {...cm} />, <Path key="b" d={full} stroke={color} strokeWidth={9} opacity={0.35} {...cm} />, <Path key="c" d={full} stroke="#fff" strokeWidth={3} {...cm} />];
  } else {
    body = <Path d={full} stroke={color} strokeWidth={rs === 4 ? 9 : 4} strokeDasharray={rs === 2 ? '10,8' : undefined} {...cm} />;
  }
  return (
    <Svg width={w} height={h}>
      {body}
      <Circle cx={P[0][0]} cy={P[0][1]} r={6} fill="#FF453A" />
      <Circle cx={P[P.length - 1][0]} cy={P[P.length - 1][1]} r={6} fill="#34C759" />
    </Svg>
  );
}

const Chips = ({ opts, val, onPick }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
    {opts.map(([l, v]) => <TouchableOpacity key={String(v)} style={[s.fpill, val === v && { backgroundColor: C.sel }]} onPress={() => onPick(v)}><Text style={s.navText}>{l}</Text></TouchableOpacity>)}
  </View>
);

const RATIOS = [['1:1', 1], ['3:4', 4 / 3], ['4:5', 1.25], ['9:16', 16 / 9], ['4:3', 0.75], ['16:9', 0.5625]];
const THEMES = ['#0B1F2E', '#2A1245', '#3A1010', '#10321F'];
const TCOLORS = ['#FFFFFF', '#6EC7C7', '#FFD60A', '#FF9500', '#FF453A', '#BF5AF2', '#34C759', '#0A84FF'];
const FONTS = [['Klasik', { fontWeight: '800' }], ['İtalik', { fontWeight: '800', fontStyle: 'italic' }], ['İnce', { fontWeight: '300' }], ['Mono', { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), fontWeight: '700' }], ['Serif', { fontFamily: Platform.select({ ios: 'Georgia', android: 'serif' }), fontWeight: '700' }]];
function ShareSheet({ t, onClose }) {
  const W = Dimensions.get('window').width - 40;
  const [bg, setBg] = useState(0), [photo, setPhoto] = useState(null), [layout, setLayout] = useState(0), [rs, setRs] = useState(0), [fi, setFi] = useState(0), [tc, setTc] = useState(TCOLORS[0]), [dim, setDim] = useState(1);
  const shot = useRef(null);
  const [tpl, setTpl] = useState(0), [scene, setScene] = useState(0), [gc, setGc] = useState(GCOL[0]), [names, setNames] = useState([]), [persp, setPersp] = useState(true), [ri, setRi] = useState(2);
  useEffect(() => {
    if (!t.route || t.route.length < 2) return;
    let live = true;
    (async () => {
      const out = [];
      for (const f of [0, 0.3, 0.55, 0.8, 1]) {
        try { const p = t.route[Math.round(f * (t.route.length - 1))]; const [a] = await Location.reverseGeocodeAsync({ latitude: p.latitude, longitude: p.longitude }); out.push(a ? a.city || a.subregion || a.district || a.region || '' : ''); } catch { out.push(''); }
      }
      if (live) setNames(out.map((n, i) => (n && n !== out[i - 1] ? n : '')));
    })();
    return () => { live = false; };
  }, []);
  const pickBg = async () => { try { const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 }); if (!r.canceled) setPhoto(r.assets[0].uri); } catch {} };
  const share = async () => {
    try { const uri = await captureRef(shot, { format: 'png', quality: 1 }); await Sharing.shareAsync(uri, { mimeType: 'image/png' }); }
    catch { AlertX.alert('Paylaşılamadı', 'Görsel oluşturulamadı, tekrar dene.'); }
  };
  const F = FONTS[fi][1];
  const rf = tpl < 2 && RATIOS[ri][1] < 1 ? 1.25 : RATIOS[ri][1], cardH = W * rf;
  const L = (k, v) => <View style={{ alignItems: 'center', marginBottom: 8 }}><Text style={[s.shL, F, { color: tc + 'CC', fontWeight: '400' }]}>{k}</Text><Text style={[s.shV, F, { color: tc }]}>{v}</Text></View>;
  const Sec = ({ children }) => <Text style={[s.itemSub, { alignSelf: 'flex-start', marginTop: 16 }]}>{children}</Text>;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20, alignItems: 'center' }}>
          <View ref={shot} collapsable={false} style={{ width: W, height: cardH, borderRadius: 24, overflow: 'hidden', backgroundColor: THEMES[bg] }}>
            {tpl < 2 ? <RoadCard t={t} W={W} H={cardH} tpl={tpl} photo={photo} scene={scene} gc={gc} dim={dim} names={names} persp={persp} /> : (<>
            {photo && <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} resizeMode="cover" />}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: photo ? `rgba(0,0,0,${[0, 0.35, 0.6][dim]})` : 'transparent', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 26 }]}>
              <View style={{ alignItems: 'center' }}>
                {L('Mesafe', `${t.dist < 10 ? t.dist.toFixed(1) : Math.round(t.dist)} km`)}
                {layout < 2 && cardH >= W * 0.8 && L('Süre', fmtDur(t.duration))}
                {layout === 1 && cardH >= W * 0.8 && L('Maks. hız', `${Math.round(t.max)} km/s`)}
                {layout === 1 && cardH >= W * 0.8 && L('Ort. hız', `${Math.round(Math.min(t.avg, t.max))} km/s`)}
              </View>
              <RouteSvg route={t.route} w={W - 60} h={cardH * (layout === 1 ? 0.3 : 0.42)} rs={rs} color={tc} />
              <Text style={[s.shBrand, F, { color: tc }]}>ApexDrive</Text>
            </View>
          </>)}
          </View>
          <Sec>Şablon</Sec>
          <View style={{ alignSelf: 'flex-start' }}><Chips opts={[['Yol 1', 0], ['Yol 2', 1], ['Klasik', 2]]} val={tpl} onPick={setTpl} /></View>
          <Sec>Oran</Sec>
          <View style={{ alignSelf: 'flex-start' }}><Chips opts={RATIOS.map(([l], i) => [l, i]).filter(([, i]) => tpl === 2 || RATIOS[i][1] >= 1)} val={rf === RATIOS[ri][1] ? ri : 2} onPick={setRi} /></View>
          {tpl < 2 && (
            <>
              <Sec>Arka plan</Sec>
              <View style={{ flexDirection: 'row', gap: 12, alignSelf: 'flex-start', marginTop: 8 }}>
                {['#C2692B', '#27507A'].map((c, i) => <TouchableOpacity key={c} onPress={() => { setScene(i); setPhoto(null); }} style={[s.dot, { backgroundColor: c, borderColor: !photo && scene === i ? C.accent : C.line }]} />)}
                <TouchableOpacity onPress={pickBg} style={[s.dot, { backgroundColor: C.card, borderColor: photo ? C.accent : C.line, alignItems: 'center', justifyContent: 'center' }]}><Ionicons name="image" size={20} color={C.text} /></TouchableOpacity>
              </View>
              <View style={{ alignSelf: 'flex-start' }}><Chips opts={[['Karartma yok', 0], ['Hafif', 1], ['Koyu', 2]]} val={dim} onPick={setDim} /></View>
              <Sec>Işık rengi</Sec>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignSelf: 'flex-start', marginTop: 8 }}>
                {GCOL.map((c) => <TouchableOpacity key={c} onPress={() => setGc(c)} style={[s.dot, { width: 36, height: 36, borderRadius: 18, backgroundColor: c, borderColor: gc === c ? C.accent : C.line }]} />)}
              </View>
              <Sec>Yol efekti</Sec>
              <View style={{ alignSelf: 'flex-start' }}><Chips opts={[['Perspektif açık', true], ['Düz', false]]} val={persp} onPick={setPersp} /></View>
            </>
          )}
          {tpl === 2 && (<>
          <Sec>Arka plan</Sec>
          <View style={{ flexDirection: 'row', gap: 12, alignSelf: 'flex-start', marginTop: 8 }}>
            {THEMES.map((c, i) => <TouchableOpacity key={c} onPress={() => { setBg(i); setPhoto(null); }} style={[s.dot, { backgroundColor: c, borderColor: !photo && bg === i ? C.accent : C.line }]} />)}
            <TouchableOpacity onPress={pickBg} style={[s.dot, { backgroundColor: C.card, borderColor: photo ? C.accent : C.line, alignItems: 'center', justifyContent: 'center' }]}><Ionicons name="image" size={20} color={C.text} /></TouchableOpacity>
          </View>
          {photo && <View style={{ alignSelf: 'flex-start' }}><Chips opts={[['Karartma yok', 0], ['Hafif', 1], ['Koyu', 2]]} val={dim} onPick={setDim} /></View>}
          <Sec>Rota stili</Sec>
          <View style={{ alignSelf: 'flex-start' }}><Chips opts={['Düz', 'Neon', 'Kesikli', 'Hız renkli', 'Kalın'].map((l, i) => [l, i])} val={rs} onPick={setRs} /></View>
          <Sec>Yazı stili</Sec>
          <View style={{ alignSelf: 'flex-start' }}><Chips opts={FONTS.map(([l], i) => [l, i])} val={fi} onPick={setFi} /></View>
          <Sec>Yazı rengi</Sec>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignSelf: 'flex-start', marginTop: 8 }}>
            {TCOLORS.map((c) => <TouchableOpacity key={c} onPress={() => setTc(c)} style={[s.dot, { width: 36, height: 36, borderRadius: 18, backgroundColor: c, borderColor: tc === c ? C.accent : C.line }]} />)}
          </View>
          <Sec>Düzen</Sec>
          <View style={{ alignSelf: 'flex-start' }}><Chips opts={[['Klasik', 0], ['Detaylı', 1], ['Minimal', 2]]} val={layout} onPick={setLayout} /></View>
          </>)}
          <TouchableOpacity style={[s.btn, { marginTop: 24 }]} onPress={share}><Text style={s.btnText}>Paylaş</Text></TouchableOpacity>
          <TouchableOpacity onPress={onClose}><Text style={{ color: C.accent, padding: 16 }}>Kapat</Text></TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ---- Araç belgeleri ve hatırlatıcı ----
const DOCS = [['sigorta', 'Trafik Sigortası', 'shield-checkmark'], ['kasko', 'Kasko', 'car-sport'], ['vize', 'Muayene / Vize', 'document-text']];
const parseDate = (x) => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(x || ''); if (!m) return null; const d = new Date(+m[3], +m[2] - 1, +m[1]); return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? d : null; };
const daysLeft = (d) => { const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / 86400000); };
const GAS = ['Bugün gazlama yapmadık 🏁 Gazlamak ister misin?', 'Yollar seni bekliyor! Bugün bir tur atalım mı?', 'Bugün haritada yeni bölgeler seni bekliyor 🗺️', 'Bir sürüş yap, rekorlarını geliştir 🔥', 'Bugün gazlama yapmadık, ne dersin? 🏍️🚗'];
async function scheduleDaily(prefs, trips) {
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(all.filter((n) => String(n.identifier).startsWith('gas-')).map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)));
    if (!prefs.daily) return;
    const perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return;
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Hatırlatmalar', importance: Notifications.AndroidImportance.HIGH });
    const drove = trips.some((t) => new Date(t.start).toDateString() === new Date().toDateString());
    const WIN = [[10, 13], [13.5, 17], [17.5, 21.5]];
    for (let i = 0; i < 5; i++) {
      const day = new Date(); day.setDate(day.getDate() + i);
      if (i === 0 && drove) continue;
      let seed = day.getFullYear() * 400 + day.getMonth() * 32 + day.getDate();
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      for (let k = 0; k < 3; k++) {
        const h = WIN[k][0] + rnd() * (WIN[k][1] - WIN[k][0]), d = new Date(day);
        d.setHours(Math.floor(h), Math.floor((h % 1) * 60), 0, 0);
        if (d.getTime() <= Date.now()) continue;
        await Notifications.scheduleNotificationAsync({ identifier: `gas-${i}-${k}`, content: { title: 'ApexDrive', body: GAS[(day.getDate() + k) % GAS.length], data: { to: 'drive' } }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: d } });
      }
    }
  } catch {}
}
async function scheduleReminders(docs, rem) {
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(all.filter((n) => !String(n.identifier).startsWith('gas-')).map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)));
    if (!DOCS.some(([k]) => parseDate(docs[k]))) return;
    const perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return;
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Hatırlatmalar', importance: Notifications.AndroidImportance.HIGH });
    for (const [k, label] of DOCS) {
      const d = parseDate(docs[k]); if (!d) continue;
      const offs = new Set([0]);
      for (let o = rem.start; o > 0; o -= rem.freq) offs.add(o);
      const times = [...offs].map((o) => { const t = new Date(d); t.setDate(t.getDate() - o); t.setHours(rem.hour, 0, 0, 0); return { t, o }; }).filter((x) => x.t.getTime() > Date.now()).sort((a, b) => a.t - b.t).slice(0, 15);
      for (const { t, o } of times) {
        await Notifications.scheduleNotificationAsync({ identifier: `veh-${k}-${o}`, content: { title: `${label} hatırlatması`, body: o === 0 ? `${label} bugün bitiyor!` : `${label} bitişine ${o} gün kaldı.` }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: t } });
      }
    }
  } catch {}
}
const fmtD = (v) => { const x = v.replace(/\D/g, '').slice(0, 8); return x.length > 4 ? `${x.slice(0, 2)}.${x.slice(2, 4)}.${x.slice(4)}` : x.length > 2 ? `${x.slice(0, 2)}.${x.slice(2)}` : x; };

function VehicleTab({ me, docs, setDocs, rem, setRem }) {
  const setStart = (k, v) => { const d = parseDate(v), y = docs['yr_' + k] || DEFY[k]; setDocs({ ...docs, ['st_' + k]: v, [k]: d ? fmtOut(addYears(d, y)) : '' }); };
  const setYears = (k, y) => { const d = parseDate(docs['st_' + k]); setDocs({ ...docs, ['yr_' + k]: y, ...(d ? { [k]: fmtOut(addYears(d, y)) } : {}) }); };
  const test = async () => {
    const p = await Notifications.requestPermissionsAsync();
    if (!p.granted) return AlertX.alert('Bildirim izni kapalı', 'Telefon ayarlarından ApexDrive bildirimlerine izin ver.');
    await Notifications.scheduleNotificationAsync({ content: { title: 'ApexDrive', body: 'Hatırlatıcılar çalışıyor 👍' }, trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 5 } });
    AlertX.alert('Gönderildi', '5 saniye içinde bildirim gelecek.');
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>Araç</Text>
      {me.car && <Text style={[s.itemSub, { marginBottom: 14 }]}>{me.car.brand} {me.car.model} · {me.car.year}</Text>}
      <Text style={[s.itemSub, { marginBottom: 12 }]}>Başlangıç tarihini ve süreyi gir, bitiş tarihi kendiliğinden hesaplanır.</Text>
      {DOCS.map(([k, label, icon]) => {
        const d = parseDate(docs[k]), left = d ? daysLeft(d) : null;
        const col = left == null ? C.dim : left <= 7 ? '#FF453A' : left <= 30 ? C.warn : '#34C759';
        return (
          <View key={k} style={[s.card, { marginBottom: 12, flexBasis: undefined }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name={icon} size={24} color={col} />
              <Text style={[s.itemTitle, { flex: 1 }]}>{label}</Text>
              {left != null && <Text style={{ color: col, fontWeight: '700' }}>{left < 0 ? `${-left} gün geçti` : left === 0 ? 'Bugün bitiyor' : `${left} gün kaldı`}</Text>}
            </View>
            <TextInput style={[s.input, { marginTop: 12 }]} value={docs['st_' + k] || ''} onChangeText={(v) => setStart(k, fmtD(v))} placeholder="Başlangıç tarihi (GG.AA.YYYY)" placeholderTextColor={C.dim} keyboardType="number-pad" maxLength={10} />
            <Chips opts={[['1 yıl', 1], ['2 yıl', 2], ['3 yıl', 3]]} val={docs['yr_' + k] || DEFY[k]} onPick={(y) => setYears(k, y)} />
            {!!docs[k] && <Text style={[s.itemSub, { marginTop: 10 }]}>Bitiş: <Text style={{ color: C.text, fontWeight: '700' }}>{docs[k]}</Text></Text>}
          </View>
        );
      })}
      <Text style={s.sec}>Hatırlatma</Text>
      <View style={[s.card, { flexBasis: undefined }]}>
        <Text style={s.itemSub}>Bu ayarlar üç belge için de geçerli.</Text>
        <Text style={[s.cLabel, { marginTop: 12 }]}>Ne zaman başlasın?</Text>
        <Chips opts={[['60 gün önce', 60], ['30 gün önce', 30], ['15 gün önce', 15], ['7 gün önce', 7], ['3 gün önce', 3]]} val={rem.start} onPick={(v) => setRem({ ...rem, start: v })} />
        <Text style={[s.cLabel, { marginTop: 14 }]}>Ne sıklıkla?</Text>
        <Chips opts={[['Her gün', 1], ['3 günde bir', 3], ['Haftada bir', 7], ['Sadece bir kez', 999]]} val={rem.freq} onPick={(v) => setRem({ ...rem, freq: v })} />
        <Text style={[s.cLabel, { marginTop: 14 }]}>Saat kaçta?</Text>
        <Chips opts={[8, 9, 12, 18, 20].map((h) => [`${String(h).padStart(2, '0')}:00`, h])} val={rem.hour} onPick={(v) => setRem({ ...rem, hour: v })} />
        <Text style={[s.itemSub, { marginTop: 14 }]}>Bitiş gününde ayrıca bir hatırlatma gelir.</Text>
      </View>
      <TouchableOpacity style={[s.btn, { backgroundColor: C.card }]} onPress={test}><Text style={[s.btnText, { color: C.accent }]}>Test bildirimi gönder</Text></TouchableOpacity>
    </ScrollView>
  );
}

// ---- Ayarlar / tek tıkla güncelleme ----
function ReplayBox({ t }) {
  const [sat, setSat] = useState(true), [playing, setPlaying] = useState(false), [rate, setRate] = useState(4), [cmd, setCmd] = useState(null), [info, setInfo] = useState({ i: 0, n: 1, v: 0 });
  const send = (js) => setCmd({ js, k: Math.random() });
  const toggle = () => { if (playing) { send('rpPause()'); setPlaying(false); } else { send(`rpPlay(${rate})`); setPlaying(true); } };
  return (
    <View style={{ marginBottom: 12 }}>
      <LeafletMap route={t.route} fit interactive={false} sat={sat} cmd={cmd} style={{ height: 300, borderRadius: 26 }} onTick={(m) => { if (m.t === 'end') setPlaying(false); setInfo((p) => ({ ...p, ...m })); }} />
      <View style={s.rbar}><View style={[s.rfill, { width: `${Math.min(100, (info.i / Math.max(1, info.n - 1)) * 100)}%` }]} /></View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 }}>
        <TouchableOpacity style={s.fab} onPress={toggle}><Ionicons name={playing ? 'pause' : 'play'} size={26} color={C.accent} /></TouchableOpacity>
        <View style={{ flex: 1 }}><Chips opts={[['1×', 1], ['4×', 4], ['16×', 16]]} val={rate} onPick={(v) => { setRate(v); if (playing) send(`rpRate(${v})`); }} /></View>
        <TouchableOpacity style={s.fab} onPress={() => setSat(!sat)}><Ionicons name={sat ? 'map' : 'earth'} size={22} color={C.text} /></TouchableOpacity>
      </View>
      <Text style={[s.itemSub, { marginTop: 8 }]}>Hız: {Math.round(info.v || 0)} km/s</Text>
    </View>
  );
}

function ViewersSheet({ story, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await api(`story_views?story_id=eq.${story.id}&order=viewed_at.desc&select=username,viewed_at`);
        const j = await r.json();
        setRows(r.ok && Array.isArray(j) ? j : 'err');
      } catch { setRows('err'); }
    })();
  }, []);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, maxHeight: '70%' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={s.sec}>Görüntüleyenler{Array.isArray(rows) ? ` (${rows.length})` : ''}</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={26} color={C.text} /></TouchableOpacity></View>
          {rows === null && <ActivityIndicator color={C.accent} />}
          {rows === 'err' && <Text style={s.hint}>Liste yüklenemedi. Sunucuda hikaye görüntüleme tablosu (SQL) eksik olabilir.</Text>}
          {Array.isArray(rows) && rows.length === 0 && <Text style={s.hint}>Henüz kimse bakmadı.</Text>}
          <ScrollView>
            {Array.isArray(rows) && rows.map((v) => (
              <View key={v.username} style={[s.item, { flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
                <View style={[s.pAv, { width: 38, height: 38, borderRadius: 19, marginVertical: 0 }]}><Text style={s.pLetter}>{v.username[0].toUpperCase()}</Text></View>
                <Text style={[s.itemTitle, { flex: 1 }]}>{v.username}</Text><Text style={s.itemSub}>{fmtDate(v.viewed_at)}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
function StoryViewer({ story, me, mine, onClose, onDeleted }) {
  const ub = unpackCap(story.caption), bm = ub.music;
  const [playing, setPlaying] = useState(false), [vw, setVw] = useState(false), [cnt, setCnt] = useState(null);
  const play = async (quiet) => {
    const ok = await playClip(bm.url, bm.start);
    setPlaying(ok);
    if (!ok && !quiet) AlertX.alert('Müzik çalınamadı', 'Telefonun sesini ve internet bağlantını kontrol et.');
  };
  useEffect(() => {
    if (!mine && me) api('story_views?on_conflict=story_id,username', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ story_id: story.id, username: me.username }) }).catch(() => {});
    if (mine) api(`story_views?story_id=eq.${story.id}&select=username`).then((r) => r.json()).then((j) => { if (Array.isArray(j)) setCnt(j.length); }).catch(() => {});
    if (bm) play(true);
    return () => { stopClip(); };
  }, []);
  const del = () => AlertX.alert('Hikaye silinsin mi?', 'Bu işlem geri alınamaz.', [{ text: 'Vazgeç', style: 'cancel' }, { text: 'Sil', style: 'destructive', onPress: async () => { try { await api(`stories?id=eq.${story.id}`, { method: 'DELETE' }); } catch {} onDeleted && onDeleted(story.id); onClose(); } }]);
  const download = async () => {
    try {
      const f = FileSystem.cacheDirectory + `hikaye_${story.id}.jpg`;
      await FileSystem.writeAsStringAsync(f, String(story.img).split(',')[1], { encoding: FileSystem.EncodingType.Base64 });
      const p = await MediaLibrary.requestPermissionsAsync(true);
      if (p.granted) { await MediaLibrary.saveToLibraryAsync(f); AlertX.alert('Kaydedildi', 'Hikaye galerine kaydedildi.'); } else await Sharing.shareAsync(f);
    } catch { AlertX.alert('İndirilemedi', 'Tekrar dene.'); }
  };
  const menu = () => AlertX.alert('Hikaye', '', [{ text: 'Hikayeyi indir', onPress: download }, { text: 'Hikayeyi sil', style: 'destructive', onPress: del }, { text: 'Vazgeç', style: 'cancel' }]);
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <Image source={{ uri: story.img }} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} resizeMode="contain" />
        <View style={s.svTop}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>{mine ? 'Hikayen' : ''}</Text>
          <TouchableOpacity onPress={onClose}><Ionicons name="close" size={30} color="#fff" /></TouchableOpacity>
        </View>
        <View style={s.svCap}>
          {!!ub.text && <Text style={{ color: '#fff', fontSize: 17, textAlign: 'center' }}>{ub.text}</Text>}
          {bm && (
            <TouchableOpacity style={s.svMusic} onPress={() => { if (playing) { stopClip(); setPlaying(false); } else play(false); }}>
              <Ionicons name={playing ? 'pause' : 'play'} size={16} color="#fff" /><Text style={{ color: '#fff' }} numberOfLines={1}>♫ {bm.title} — {bm.artist}</Text>
            </TouchableOpacity>
          )}
        </View>
        {mine && (
          <>
            <TouchableOpacity style={[s.svBtn, { left: 18 }]} onPress={() => setVw(true)}><Ionicons name="eye" size={22} color="#fff" /><Text style={{ color: '#fff', fontWeight: '700' }}>{cnt == null ? '' : cnt}</Text></TouchableOpacity>
            <TouchableOpacity style={[s.svBtn, { right: 18 }]} onPress={menu}><Ionicons name="ellipsis-horizontal" size={24} color="#fff" /></TouchableOpacity>
          </>
        )}
        {vw && <ViewersSheet story={story} onClose={() => setVw(false)} />}
      </View>
    </Modal>
  );
}
function MyStories({ me, onClose, onAdd }) {
  const [rows, setRows] = useState(null), [big, setBig] = useState(null);
  const load = async () => {
    try {
      const r = await api(`stories?username=eq.${encodeURIComponent(me.username)}&created_at=gte.${new Date(Date.now() - 864e5).toISOString()}&order=created_at.desc&select=id,caption,img,created_at`);
      const j = await r.json();
      setRows(Array.isArray(j) ? j : []);
    } catch { setRows([]); }
  };
  useEffect(() => { load(); }, []);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={s.title}>Hikayelerim</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color={C.text} /></TouchableOpacity></View>
          <TouchableOpacity style={[s.btn, { marginTop: 0, marginBottom: 14 }]} onPress={onAdd}><Text style={s.btnText}>Hikaye ekle</Text></TouchableOpacity>
          {rows === null && <ActivityIndicator color={C.accent} />}
          {rows && rows.length === 0 && <Text style={s.hint}>Aktif hikayen yok. Hikayeler 24 saat görünür.</Text>}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(rows || []).map((x) => (
              <TouchableOpacity key={x.id} style={{ width: '31%' }} onPress={() => setBig(x)}>
                <Image source={{ uri: x.img }} style={{ width: '100%', aspectRatio: 0.8, borderRadius: 14 }} />
                {unpackCap(x.caption).music ? <Text style={s.sbadge}>♫</Text> : null}
                <Text style={[s.itemSub, { fontSize: 11, marginTop: 4 }]}>{fmtDate(x.created_at)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
        {big && <StoryViewer story={big} me={me} mine onClose={() => setBig(null)} onDeleted={load} />}
      </SafeAreaView>
    </Modal>
  );
}
function PersonSheet({ u, me, onClose }) {
  const [pr, setPr] = useState(null), [st, setSt] = useState([]), [big, setBig] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        setPr((await (await api(`profiles?username=eq.${encodeURIComponent(u)}&select=username,total_km,top_speed,trips,car_brand,car_model,car_year`)).json())[0] || { username: u });
        setSt(await (await api(`stories?username=eq.${encodeURIComponent(u)}&created_at=gte.${new Date(Date.now() - 864e5).toISOString()}&order=created_at.desc&select=id,caption,img,created_at`)).json());
      } catch {}
    })();
  }, [u]);
  return (
    <>
      <Modal visible transparent animationType="slide" onRequestClose={onClose}>
        <View style={s.modalBg}>
          <View style={s.modal}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={[s.pAv, { width: 56, height: 56, borderRadius: 28 }]}><Text style={s.pLetter}>{u[0].toUpperCase()}</Text></View>
              <View style={{ flex: 1 }}><Text style={s.name}>{u}</Text><Text style={s.itemSub}>{pr?.car_brand ? `${pr.car_brand} ${pr.car_model} · ${pr.car_year || ''}` : ''}</Text></View>
            </View>
            {pr?.total_km != null && <Text style={[s.itemSub, { marginTop: 10 }]}>{pr.total_km.toFixed(0)} km · {pr.trips} sürüş · maks. {Math.round(pr.top_speed)} km/s</Text>}
            <Text style={s.sec}>Hikayeler (24 saat)</Text>
            <ScrollView horizontal>
              {(!Array.isArray(st) || st.length === 0) && <Text style={s.hint}>Aktif hikaye yok.</Text>}
              {Array.isArray(st) && st.map((x) => <TouchableOpacity key={x.id} onPress={() => setBig(x)}><Image source={{ uri: x.img }} style={s.sthumb} />{unpackCap(x.caption).music ? <Text style={s.sbadge}>♫</Text> : null}</TouchableOpacity>)}
            </ScrollView>
            <TouchableOpacity style={[s.btn, { backgroundColor: C.line }]} onPress={onClose}><Text style={[s.btnText, { color: C.text }]}>Kapat</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
      {big && <StoryViewer story={big} me={me} mine={false} onClose={() => setBig(null)} />}
    </>
  );
}

// ---- Açılış animasyonu ----
function Intro({ onDone }) {
  const t = useRef(new Animated.Value(0)).current, fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
    Animated.sequence([
      Animated.timing(t, { toValue: 1, duration: 1700, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(fade, { toValue: 0, duration: 350, useNativeDriver: true }),
    ]).start(() => onDone());
  }, []);
  const I = (r, o, x) => t.interpolate({ inputRange: r, outputRange: o, ...(x || {}) });
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#0B2B4A', alignItems: 'center', justifyContent: 'center', opacity: fade }]}>
      <StatusBar style="light" />
      {[0.34, 0.5, 0.66].map((y, i) => (
        <Animated.View key={i} style={{ position: 'absolute', top: `${y * 100}%`, left: 0, width: 180, height: 3, borderRadius: 2, backgroundColor: i === 1 ? '#FF9A3C' : '#6EC7C7', opacity: I([0, 0.3, 0.8, 1], [0, 0.9, 0.5, 0]), transform: [{ translateX: I([0, 1], [-200, 620 + i * 40]) }] }} />
      ))}
      <Animated.View style={{ position: 'absolute', width: 220, height: 220, borderRadius: 110, borderWidth: 2, borderColor: '#6EC7C7', opacity: I([0, 0.25, 1], [0, 0.6, 0]), transform: [{ scale: I([0, 1], [0.7, 2.4]) }] }} />
      <Animated.Image source={require('./splash-icon.png')} style={{ width: 220, height: 220, transform: [{ scale: I([0, 0.45, 1], [1, 1.1, 1]) }] }} resizeMode="contain" />
      <Animated.Text style={{ color: '#fff', fontSize: 30, fontWeight: '800', fontStyle: 'italic', marginTop: 6, opacity: I([0.3, 0.7], [0, 1], { extrapolate: 'clamp' }), transform: [{ translateY: I([0.3, 0.7], [16, 0], { extrapolate: 'clamp' }) }] }}>ApexDrive</Animated.Text>
    </Animated.View>
  );
}

// ---- Müzik (iTunes önizleme) ----
const MARK = '\u2063\u266B';
const packCap = (cap, m) => (m ? `${cap}${MARK}${JSON.stringify(m)}` : cap);
const unpackCap = (c) => {
  const x = String(c || ''), i = x.indexOf(MARK);
  if (i < 0) return { text: x, music: null };
  try { return { text: x.slice(0, i), music: JSON.parse(x.slice(i + MARK.length)) }; } catch { return { text: x.slice(0, i), music: null }; }
};
const sfx = { s: null };
async function stopClip() { try { if (sfx.s) await sfx.s.unloadAsync(); } catch {} sfx.s = null; }
async function playClip(url, start) {
  await stopClip();
  try { await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, shouldDuckAndroid: true }); } catch {}
  try {
    const { sound } = await Audio.Sound.createAsync({ uri: url }, { shouldPlay: true, positionMillis: start * 1000 });
    sfx.s = sound;
    sound.setOnPlaybackStatusUpdate((st) => { if (st.isLoaded && st.positionMillis >= (start + 15) * 1000) sound.setPositionAsync(start * 1000).catch(() => {}); });
    return true;
  } catch { return false; }
}
function MusicSheet({ onPick, onClose }) {
  const [q, setQ] = useState(''), [res, setRes] = useState([]), [busy, setBusy] = useState(false), [sel, setSel] = useState(null), [start, setStart] = useState(0), [err, setErr] = useState('');
  useEffect(() => () => { stopClip(); }, []);
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr('');
    try {
      const j = await (await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q.trim())}&media=music&entity=song&limit=25&country=TR`)).json();
      const r = (j.results || []).filter((x) => x.previewUrl);
      setRes(r); if (!r.length) setErr('Sonuç bulunamadı.');
    } catch { setErr('Arama yapılamadı. İnternetini kontrol et.'); }
    setBusy(false);
  };
  const choose = (r) => { setSel(r); playClip(r.previewUrl, start); };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, height: '78%' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={s.sec}>Müzik ekle</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={26} color={C.text} /></TouchableOpacity></View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TextInput style={[s.input, { flex: 1, marginTop: 0, padding: 12 }]} value={q} onChangeText={setQ} onSubmitEditing={search} returnKeyType="search" placeholder="Şarkı veya sanatçı ara" placeholderTextColor={C.dim} />
            <TouchableOpacity style={[s.fpill, { backgroundColor: C.accent }]} onPress={search}><Ionicons name="search" size={18} color="#06101F" /></TouchableOpacity>
          </View>
          {busy && <ActivityIndicator color={C.accent} style={{ marginTop: 12 }} />}
          {!!err && <Text style={s.hint}>{err}</Text>}
          <FlatList data={res} keyExtractor={(r) => String(r.trackId)} style={{ marginTop: 10 }} keyboardShouldPersistTaps="handled" renderItem={({ item }) => (
            <TouchableOpacity style={[s.item, { flexDirection: 'row', alignItems: 'center' }, sel?.trackId === item.trackId && { borderWidth: 1, borderColor: C.accent }]} onPress={() => choose(item)}>
              <Image source={{ uri: item.artworkUrl100 }} style={{ width: 46, height: 46, borderRadius: 10, marginRight: 12 }} />
              <View style={{ flex: 1 }}><Text style={s.itemTitle} numberOfLines={1}>{item.trackName}</Text><Text style={s.itemSub} numberOfLines={1}>{item.artistName}</Text></View>
              <Ionicons name={sel?.trackId === item.trackId ? 'volume-high' : 'play-circle'} size={26} color={C.accent} />
            </TouchableOpacity>
          )} />
          {sel && (
            <View>
              <Text style={[s.itemSub, { marginTop: 8 }]}>Hangi kısım çalsın? (15 sn)</Text>
              <Chips opts={[0, 5, 10, 15].map((x) => [`${x}–${x + 15} sn`, x])} val={start} onPick={(x) => { setStart(x); playClip(sel.previewUrl, x); }} />
              <TouchableOpacity style={s.btn} onPress={() => { stopClip(); onPick({ title: sel.trackName, artist: sel.artistName, art: sel.artworkUrl100, url: sel.previewUrl, start }); }}><Text style={s.btnText}>Ekle</Text></TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
const MusicPill = ({ m }) => (
  <View style={s.edPill}>
    {m.art ? <Image source={{ uri: m.art }} style={{ width: 38, height: 38, borderRadius: 8 }} /> : null}
    <View style={{ marginLeft: 8, maxWidth: 170 }}><Text style={s.edPT} numberOfLines={1}>{m.title}</Text><Text style={s.edPA} numberOfLines={1}>{m.artist}</Text></View>
    <Ionicons name="musical-notes" size={18} color="#fff" style={{ marginLeft: 8 }} />
  </View>
);
// Çok parmaklı yerleştirme: sürükle, iki parmakla büyüt/küçült/döndür
function Sticker({ children, x0, y0, onDrag, hit, onDrop }) {
  const st = useRef({ x: x0, y: y0, s: 1, r: 0 }).current, g = useRef({ lx: 0, ly: 0 }).current, P = useRef({}), [, bump] = useState(0);
  P.current = { onDrag, hit, onDrop };
  const cen = (e) => {
    const t = e.nativeEvent.touches || [], n = t.length;
    if (!n) return null;
    let x = 0, y = 0; t.forEach((q) => { x += q.pageX; y += q.pageY; });
    return { x: x / n, y: y / n, n, d: n > 1 ? Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY) : 0, a: n > 1 ? Math.atan2(t[1].pageY - t[0].pageY, t[1].pageX - t[0].pageX) : 0 };
  };
  const base = (c) => { g.n = c.n; g.cx = c.x; g.cy = c.y; g.sx = st.x; g.sy = st.y; g.d = c.d; g.a = c.a; g.s = st.s; g.r = st.r; };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { const c = cen(e); if (c) { base(c); g.lx = c.x; g.ly = c.y; } P.current.onDrag(true, false); },
    onPanResponderMove: (e) => {
      const c = cen(e);
      if (!c) return;
      if (c.n !== g.n) base(c);
      st.x = g.sx + (c.x - g.cx); st.y = g.sy + (c.y - g.cy);
      if (c.n > 1 && g.d > 0) { st.s = Math.max(0.3, Math.min(6, g.s * (c.d / g.d))); st.r = g.r + (c.a - g.a); }
      g.lx = c.x; g.ly = c.y;
      P.current.onDrag(true, P.current.hit(c.x, c.y)); bump((v) => v + 1);
    },
    onPanResponderRelease: () => { const o = P.current.hit(g.lx, g.ly); P.current.onDrag(false, false); P.current.onDrop(o); },
    onPanResponderTerminate: () => { P.current.onDrag(false, false); },
  })).current;
  return <View {...pan.panHandlers} style={{ position: 'absolute', left: st.x, top: st.y, padding: 16, transform: [{ rotate: `${st.r}rad` }, { scale: st.s }] }}>{children}</View>;
}
const SR = [['9:16', 16 / 9], ['4:5', 1.25], ['1:1', 1]];
function StoryEditor({ uri, onDone, onCancel }) {
  const { width: SW, height: SH } = Dimensions.get('window');
  const [ri, setRi] = useState(0), [items, setItems] = useState([]), [txt, setTxt] = useState(null), [mus, setMus] = useState(false), [busy, setBusy] = useState(false), [drag, setDrag] = useState({ on: false, over: false });
  const shot = useRef(null), wrap = useRef(null), org = useRef({ x: 0, y: 0 });
  const ch = Math.min((SW - 32) * SR[ri][1], SH * 0.64), cw = ch / SR[ri][1];
  const add = (it) => setItems((p) => [...p, { id: Date.now() + Math.random(), ...it }]);
  const hit = (cx, cy) => Math.hypot(cx - (org.current.x + cw / 2), cy - (org.current.y + ch - 44)) < 56;
  const done = async () => {
    setBusy(true);
    try {
      const b = await captureRef(shot, { format: 'jpg', quality: 0.65, result: 'base64', width: 720, height: Math.round(720 * SR[ri][1]) });
      const m = items.filter((x) => x.kind === 'music').pop();
      onDone(b, SR[ri][1], m ? m.m : null);
    } catch { AlertX.alert('Hazırlanamadı', 'Görsel oluşturulamadı, tekrar dene.'); }
    setBusy(false);
  };
  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <SafeAreaView style={s.root}>
        <View style={s.edTop}>
          <TouchableOpacity onPress={onCancel} style={{ padding: 6 }}><Ionicons name="close" size={28} color={C.text} /></TouchableOpacity>
          <TouchableOpacity style={s.edOk} onPress={done} disabled={busy}><Ionicons name="checkmark" size={20} color="#06101F" /><Text style={s.btnText}>{busy ? '...' : 'Tamam'}</Text></TouchableOpacity>
        </View>
        <View style={{ alignItems: 'center' }}>
          <View ref={wrap} onLayout={() => wrap.current && wrap.current.measureInWindow((x, y) => { org.current = { x, y }; })} style={{ width: cw, height: ch }}>
            <View ref={shot} collapsable={false} style={{ width: cw, height: ch, borderRadius: 18, overflow: 'hidden', backgroundColor: '#000' }}>
              <Image source={{ uri }} style={{ width: cw, height: ch }} resizeMode="cover" />
              {items.map((it) => (
                <Sticker key={it.id} x0={cw * 0.12} y0={ch * (it.kind === 'music' ? 0.7 : 0.4)} onDrag={(a, o) => setDrag({ on: a, over: o })} hit={hit} onDrop={(o) => { if (o) setItems((p) => p.filter((x) => x.id !== it.id)); }}>
                  {it.kind === 'text' ? <Text style={[s.edTxt, { color: it.c }]}>{it.t}</Text> : <MusicPill m={it.m} />}
                </Sticker>
              ))}
            </View>
            <View style={s.edTools}>
              <TouchableOpacity style={s.edBtn} onPress={() => setTxt({ t: '', c: '#FFFFFF' })}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 17 }}>Aa</Text></TouchableOpacity>
              <TouchableOpacity style={s.edBtn} onPress={() => setMus(true)}><Ionicons name="musical-notes" size={22} color="#fff" /></TouchableOpacity>
              <TouchableOpacity style={s.edBtn} onPress={() => setItems((p) => p.slice(0, -1))}><Ionicons name="arrow-undo" size={22} color="#fff" /></TouchableOpacity>
            </View>
            {drag.on && <View style={[s.edTrash, drag.over && { backgroundColor: '#FF453A' }]}><Ionicons name="trash" size={26} color="#fff" /></View>}
          </View>
        </View>
        <View style={{ alignItems: 'center', marginTop: 12 }}><Chips opts={SR.map(([l], i) => [l, i])} val={ri} onPick={setRi} /></View>
        <Text style={[s.hint, { marginTop: 8 }]}>Sürükle, iki parmakla büyüt/küçült/döndür. Silmek için alttaki çöp kutusuna bırak.</Text>
        {txt && (
          <Modal visible transparent animationType="fade" onRequestClose={() => setTxt(null)}>
            <View style={s.modalBg}>
              <View style={s.modal}>
                <TextInput style={[s.input, { marginTop: 0 }]} value={txt.t} onChangeText={(t) => setTxt({ ...txt, t })} placeholder="Yazını yaz" placeholderTextColor={C.dim} autoFocus maxLength={80} multiline />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
                  {TCOLORS.map((c) => <TouchableOpacity key={c} onPress={() => setTxt({ ...txt, c })} style={[s.dot, { width: 34, height: 34, borderRadius: 17, backgroundColor: c, borderColor: txt.c === c ? C.accent : C.line }]} />)}
                </View>
                <TouchableOpacity style={s.btn} onPress={() => { if (txt.t.trim()) add({ kind: 'text', t: txt.t.trim(), c: txt.c }); setTxt(null); }}><Text style={s.btnText}>Ekle</Text></TouchableOpacity>
              </View>
            </View>
          </Modal>
        )}
        {mus && <MusicSheet onClose={() => setMus(false)} onPick={(m) => { add({ kind: 'music', m }); setMus(false); }} />}
      </SafeAreaView>
    </Modal>
  );
}
function StoryComposer({ me, pos, onClose }) {
  const [uri, setUri] = useState(null), [img, setImg] = useState(null), [ratio, setRatio] = useState(1.25), [music, setMusic] = useState(null), [cap, setCap] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
        if (r.canceled) onClose(); else setUri(r.assets[0].uri);
      } catch { onClose(); }
    })();
  }, []);
  const post = async () => {
    setBusy(true);
    try {
      await api('stories?created_at=lt.' + new Date(Date.now() - 864e5).toISOString(), { method: 'DELETE' });
      const row = { username: me.username, car: me.car ? `${me.car.brand} ${me.car.model}` : '', lat: +pos.latitude.toFixed(2), lon: +pos.longitude.toFixed(2), caption: packCap(cap.trim(), music), img };
      const r = await api('stories', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) });
      if (!r.ok) throw 0;
      onClose();
    } catch { AlertX.alert('Paylaşılamadı', 'Bağlantını ve sunucu ayarlarını kontrol et.'); }
    setBusy(false);
  };
  if (!uri) return null;
  if (!img) return <StoryEditor uri={uri} onCancel={onClose} onDone={(b, r, m) => { setImg(`data:image/jpeg;base64,${b}`); setRatio(r); setMusic(m); }} />;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
          <Text style={s.title}>Hikaye paylaş</Text>
          <Image source={{ uri: img }} style={{ width: '100%', aspectRatio: 1 / ratio, borderRadius: 24 }} />
          {music && <Text style={[s.itemSub, { marginTop: 10 }]}>♫ {music.title} — {music.artist}</Text>}
          <TextInput style={s.input} value={cap} onChangeText={setCap} placeholder="Bir şey yaz (isteğe bağlı)" placeholderTextColor={C.dim} maxLength={120} />
          <Text style={s.hint}>Hikaye 24 saat görünür ve yaklaşık konumunla (≈1 km) paylaşılır.</Text>
          <TouchableOpacity style={s.btn} onPress={post} disabled={busy}><Text style={s.btnText}>{busy ? 'Paylaşılıyor...' : 'Paylaş'}</Text></TouchableOpacity>
          <TouchableOpacity onPress={onClose}><Text style={{ color: C.accent, textAlign: 'center', padding: 14 }}>Vazgeç</Text></TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ---- Kulüp yardımcıları ----
async function shrink(uri, w, png) {
  try {
    const r = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: w } }], { compress: 0.6, format: png ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG, base64: true });
    return `data:image/${png ? 'png' : 'jpeg'};base64,${r.base64}`;
  } catch { return null; }
}
const mcache = new Map();
async function loadMedia(id) {
  if (mcache.has(id)) return mcache.get(id);
  const j = await (await api(`club_posts?id=eq.${id}&select=media`)).json();
  const m = j[0] && j[0].media;
  if (m) mcache.set(id, m);
  return m;
}
async function openClubFile(p) {
  try {
    const m = JSON.parse(p.meta || '{}'), b = await loadMedia(p.id);
    const f = FileSystem.cacheDirectory + String(m.name || 'dosya').replace(/[^\w.\-]/g, '_');
    await FileSystem.writeAsStringAsync(f, b, { encoding: FileSystem.EncodingType.Base64 });
    await Sharing.shareAsync(f, { mimeType: m.mime });
  } catch { AlertX.alert('Dosya açılamadı', 'Tekrar dene.'); }
}
const fileMeta = (p) => { try { return JSON.parse(p.meta || '{}'); } catch { return {}; } };
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
function MediaImg({ id, style, contain, onPress, onLong }) {
  const [u, setU] = useState(mcache.get(id) || null);
  useEffect(() => { if (!u) loadMedia(id).then(setU).catch(() => {}); }, [id]);
  const img = u ? <Image source={{ uri: u }} style={style} resizeMode={contain ? 'contain' : 'cover'} /> : <View style={[style, { backgroundColor: C.line, alignItems: 'center', justifyContent: 'center' }]}><ActivityIndicator color={C.accent} /></View>;
  return onPress || onLong ? <TouchableOpacity onPress={onPress ? () => onPress(u) : undefined} onLongPress={onLong} delayLongPress={350}>{img}</TouchableOpacity> : img;
}
function Linkify({ text, style, onLong }) {
  const parts = String(text || '').split(/(https?:\/\/[^\s]+)/g);
  return <Text style={style}>{parts.map((p, i) => (/^https?:\/\//.test(p) ? <Text key={i} style={{ color: C.accent, textDecorationLine: 'underline' }} onPress={() => Linking.openURL(p).catch(() => {})} onLongPress={onLong}>{p}</Text> : p))}</Text>;
}
function Av({ club, size = 40 }) {
  return club.photo
    ? <Image source={{ uri: club.photo }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.line }} />
    : <View style={[s.pAv, { width: size, height: size, borderRadius: size / 2, marginVertical: 0 }]}><Text style={s.pLetter}>{String(club.name || '?')[0].toUpperCase()}</Text></View>;
}
const EMO = ['🏁', '🔥', '🚗', '🏍️', '💨', '⚡', '🛞', '🏆', '😎', '🤘', '👍', '😂', '❤️', '🛣️', '⛽', '🔧'];
function StickerSheet({ onPick, onClose }) {
  const [mine, setMine] = useState([]);
  useEffect(() => { AsyncStorage.getItem('@apexdrive_stickers').then((v) => v && setMine(JSON.parse(v))).catch(() => {}); }, []);
  const save = (n) => { setMine(n); AsyncStorage.setItem('@apexdrive_stickers', JSON.stringify(n)).catch(() => {}); };
  const add = async () => {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (r.canceled) return;
      const d = await shrink(r.assets[0].uri, 256, true);
      if (!d) return AlertX.alert('Çıkartma hazırlanamadı', 'Başka bir görsel dene.');
      save([d, ...mine].slice(0, 30));
    } catch {}
  };
  const del = (d) => AlertX.alert('Çıkartma silinsin mi?', '', [{ text: 'Vazgeç', style: 'cancel' }, { text: 'Sil', style: 'destructive', onPress: () => save(mine.filter((x) => x !== d)) }]);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, maxHeight: '70%' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={s.sec}>Çıkartmalar</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={26} color={C.text} /></TouchableOpacity></View>
          <ScrollView>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{EMO.map((e) => <TouchableOpacity key={e} style={s.stkCell} onPress={() => onPick({ kind: 'sticker', body: e })}><Text style={{ fontSize: 34 }}>{e}</Text></TouchableOpacity>)}</View>
            <Text style={[s.itemSub, { marginTop: 16, marginBottom: 8 }]}>Çıkartmalarım (uzun basarak silebilirsin)</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <TouchableOpacity style={[s.stkCell, { backgroundColor: C.card }]} onPress={add}><Ionicons name="add" size={30} color={C.accent} /></TouchableOpacity>
              {mine.map((d) => <TouchableOpacity key={d.slice(-40)} style={s.stkCell} onPress={() => onPick({ kind: 'sticker', body: '', media: d, meta: 'img' })} onLongPress={() => del(d)}><Image source={{ uri: d }} style={{ width: 56, height: 56 }} resizeMode="contain" /></TouchableOpacity>)}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
function ClubMedia({ club, onClose }) {
  const [tab, setTab] = useState('image'), [rows, setRows] = useState([]), [big, setBig] = useState(null), [err, setErr] = useState(false);
  useEffect(() => {
    (async () => {
      setRows([]); setErr(false);
      try {
        const base = `club_posts?club_id=eq.${club.id}&order=created_at.desc&limit=80`;
        const r = tab === 'link' ? await api(`${base}&body=ilike.*http*&select=id,username,body,created_at`) : await api(`${base}&kind=eq.${tab}&select=id,username,created_at,meta`);
        const j = await r.json();
        if (!r.ok || !Array.isArray(j)) throw 0;
        setRows(tab === 'link' ? j.flatMap((p) => (String(p.body).match(/https?:\/\/[^\s]+/g) || []).map((u, i) => ({ id: p.id + '-' + i, url: u, username: p.username, created_at: p.created_at }))) : j);
      } catch { setErr(true); }
    })();
  }, [tab]);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={s.title}>Medya</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color={C.text} /></TouchableOpacity></View>
          <Chips opts={[['Fotoğraflar', 'image'], ['Dosyalar', 'file'], ['Linkler', 'link']]} val={tab} onPick={setTab} />
          {err && <Text style={s.hint}>Yüklenemedi. Sunucu güncellemesi (SQL) gerekiyor olabilir.</Text>}
          {!err && rows.length === 0 && <Text style={s.hint}>Burada henüz bir şey yok.</Text>}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
            {tab === 'image' && rows.map((p) => <MediaImg key={p.id} id={p.id} style={{ width: '32%', aspectRatio: 1, borderRadius: 12 }} onPress={(u) => u && setBig(u)} />)}
          </View>
          {tab === 'file' && rows.map((p) => (
            <TouchableOpacity key={p.id} style={[s.item, { flexDirection: 'row', alignItems: 'center', gap: 12 }]} onPress={() => openClubFile(p)}>
              <Ionicons name="document-text" size={28} color={C.accent} />
              <View style={{ flex: 1 }}><Text style={s.itemTitle} numberOfLines={1}>{fileMeta(p).name || 'Dosya'}</Text><Text style={s.itemSub}>{p.username} · {fmtSize(fileMeta(p).size || 0)}</Text></View>
            </TouchableOpacity>
          ))}
          {tab === 'link' && rows.map((p) => (
            <TouchableOpacity key={p.id} style={s.item} onPress={() => Linking.openURL(p.url).catch(() => {})}>
              <Text style={[s.itemTitle, { color: C.accent }]} numberOfLines={2}>{p.url}</Text><Text style={s.itemSub}>{p.username} · {fmtDate(p.created_at)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        {big && <Modal visible transparent animationType="fade" onRequestClose={() => setBig(null)}><TouchableOpacity activeOpacity={1} style={[s.modalBg, { backgroundColor: '#000' }]} onPress={() => setBig(null)}><Image source={{ uri: big }} style={{ width: '100%', height: '80%' }} resizeMode="contain" /></TouchableOpacity></Modal>}
      </SafeAreaView>
    </Modal>
  );
}
function ClubSettings({ club, me, mem, setClub, onClose, onChanged, onLeft }) {
  const [sel, setSel] = useState(null), [media, setMedia] = useState(false), [nm, setNm] = useState(club.name), [ab, setAb] = useState(club.about || '');
  const isOwner = club.owner === me.username, mine = mem.find((m) => m.username === me.username), isAdmin = !!mine && mine.role === 'admin', isM = !!mine || isOwner;
  const can = (m) => m.username !== me.username && m.username !== club.owner && (isOwner || (isAdmin && m.role !== 'admin'));
  const names = (a) => a.map(encodeURIComponent).join(',');
  const patchClub = async (patch) => {
    try {
      const r = await api(`clubs?id=eq.${club.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      if (r.status === 409) return AlertX.alert('Bu kulüp adı alınmış', 'Başka bir ad dene.');
      if (!r.ok) return AlertX.alert('Kaydedilemedi', patch.photo !== undefined ? 'Sunucuda kulüp güncellemesi (SQL) eksik olabilir.' : 'Tekrar dene.');
      setClub({ ...club, ...patch });
    } catch { AlertX.alert('Kaydedilemedi', 'Bağlantını kontrol et.'); }
  };
  const pickPhoto = async () => {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: true, aspect: [1, 1] });
      if (r.canceled) return;
      const d = await shrink(r.assets[0].uri, 320);
      if (d) patchClub({ photo: d }); else AlertX.alert('Fotoğraf hazırlanamadı', 'Başka bir fotoğraf dene.');
    } catch {}
  };
  const roleOp = async (list, role) => {
    try {
      const r = await api(`club_members?club_id=eq.${club.id}&username=in.(${names(list)})`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ role }) });
      if (!r.ok) AlertX.alert('İşlem yapılamadı', 'Sunucuda kulüp güncellemesi (SQL) eksik olabilir.');
    } catch {}
    setSel(null); onChanged();
  };
  const kick = (list) => AlertX.alert('Kulüpten çıkarılsın mı?', list.length > 1 ? `${list.length} üye çıkarılacak.` : list[0], [{ text: 'Vazgeç', style: 'cancel' }, { text: 'Çıkar', style: 'destructive', onPress: async () => { try { await api(`club_members?club_id=eq.${club.id}&username=in.(${names(list)})`, { method: 'DELETE' }); } catch {} setSel(null); onChanged(); } }]);
  const manage = (m) => AlertX.alert(m.username, m.role === 'admin' ? 'Yönetici' : 'Üye', [
    ...(isOwner ? [m.role === 'admin' ? { text: 'Yöneticiliği kaldır', onPress: () => roleOp([m.username], 'member') } : { text: 'Yönetici yap', onPress: () => roleOp([m.username], 'admin') }] : []),
    { text: 'Kulüpten çıkar', style: 'destructive', onPress: () => kick([m.username]) },
    { text: 'Vazgeç', style: 'cancel' },
  ]);
  const leave = () => AlertX.alert('Kulüpten ayrılmak istiyor musun?', club.name, [{ text: 'Vazgeç', style: 'cancel' }, { text: 'Ayrıl', style: 'destructive', onPress: async () => { try { await api(`club_members?club_id=eq.${club.id}&username=eq.${me.username}`, { method: 'DELETE' }); } catch {} onLeft(); } }]);
  const del = () => AlertX.alert('Kulüp silinsin mi?', 'Tüm mesajlar ve üyelikler silinir. Bu işlem geri alınamaz.', [{ text: 'Vazgeç', style: 'cancel' }, { text: 'Sil', style: 'destructive', onPress: async () => { try { await api(`clubs?id=eq.${club.id}`, { method: 'DELETE' }); } catch {} onLeft(); } }]);
  const toggle = (u) => setSel((p) => (p.includes(u) ? p.filter((x) => x !== u) : [...p, u]));
  const chosen = sel || [];
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={s.title}>Kulüp ayarları</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color={C.text} /></TouchableOpacity></View>
          <View style={{ alignItems: 'center', marginBottom: 14 }}>
            <TouchableOpacity disabled={!(isOwner || isAdmin)} onPress={pickPhoto}>
              <Av club={club} size={96} />
              {(isOwner || isAdmin) && <View style={s.camBadge}><Ionicons name="camera" size={16} color="#06101F" /></View>}
            </TouchableOpacity>
            {isOwner ? (
              <View style={{ width: '100%' }}>
                <TextInput style={[s.input, { textAlign: 'center', fontWeight: '800' }]} value={nm} onChangeText={setNm} maxLength={40} />
                <TextInput style={s.input} value={ab} onChangeText={setAb} placeholder="Kısa açıklama" placeholderTextColor={C.dim} maxLength={140} />
                {(nm.trim() !== club.name || ab.trim() !== (club.about || '')) && nm.trim().length >= 3 && <TouchableOpacity style={s.btn} onPress={() => patchClub({ name: nm.trim(), about: ab.trim() })}><Text style={s.btnText}>Kaydet</Text></TouchableOpacity>}
              </View>
            ) : (<View style={{ alignItems: 'center' }}><Text style={[s.name, { marginTop: 10 }]}>{club.name}</Text>{!!club.about && <Text style={s.itemSub}>{club.about}</Text>}</View>)}
          </View>
          <TouchableOpacity style={[s.item, { flexDirection: 'row', alignItems: 'center', gap: 12 }]} onPress={() => setMedia(true)}>
            <Ionicons name="images" size={24} color={C.accent} /><Text style={[s.itemTitle, { flex: 1 }]}>Medya, dosya ve linkler</Text><Ionicons name="chevron-forward" size={20} color={C.dim} />
          </TouchableOpacity>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={s.sec}>Üyeler ({mem.length})</Text>
            {(isOwner || isAdmin) && <TouchableOpacity onPress={() => setSel(sel ? null : [])}><Text style={{ color: C.accent, fontWeight: '700' }}>{sel ? 'Bitti' : 'Seç'}</Text></TouchableOpacity>}
          </View>
          {mem.map((m) => (
            <View key={m.username} style={[s.item, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
              {sel && <TouchableOpacity disabled={!can(m)} onPress={() => toggle(m.username)} style={[s.chk, chosen.includes(m.username) && { backgroundColor: C.accent, borderColor: C.accent }, !can(m) && { opacity: 0.25 }]}>{chosen.includes(m.username) && <Ionicons name="checkmark" size={16} color="#06101F" />}</TouchableOpacity>}
              <View style={[s.pAv, { width: 40, height: 40, borderRadius: 20, marginVertical: 0 }]}><Text style={s.pLetter}>{m.username[0].toUpperCase()}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={s.itemTitle}>{m.username}{m.username === club.owner ? '  👑' : m.role === 'admin' ? '  ★' : ''}</Text>
                <Text style={s.itemSub}>{m.username === club.owner ? 'Kurucu' : m.role === 'admin' ? 'Yönetici' : m.car_brand ? `${m.car_brand} ${m.car_model}` : 'Üye'}</Text>
              </View>
              {can(m) && !sel && <TouchableOpacity onPress={() => manage(m)} style={{ padding: 6 }}><Ionicons name="ellipsis-horizontal" size={22} color={C.text} /></TouchableOpacity>}
            </View>
          ))}
          {sel && chosen.length > 0 && (
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
              {isOwner && <TouchableOpacity style={[s.btn, { flex: 1, marginTop: 0 }]} onPress={() => roleOp(chosen, 'admin')}><Text style={s.btnText}>Yönetici yap</Text></TouchableOpacity>}
              <TouchableOpacity style={[s.btn, { flex: 1, marginTop: 0, backgroundColor: '#FF453A22' }]} onPress={() => kick(chosen)}><Text style={[s.btnText, { color: '#FF6B6B' }]}>Çıkar ({chosen.length})</Text></TouchableOpacity>
            </View>
          )}
          {isM && !isOwner && <TouchableOpacity style={[s.btn, { backgroundColor: '#FF453A22' }]} onPress={leave}><Text style={[s.btnText, { color: '#FF6B6B' }]}>Kulüpten ayrıl</Text></TouchableOpacity>}
          {isOwner && <TouchableOpacity style={[s.btn, { backgroundColor: '#FF453A22' }]} onPress={del}><Text style={[s.btnText, { color: '#FF6B6B' }]}>Kulübü sil</Text></TouchableOpacity>}
        </ScrollView>
        {media && <ClubMedia club={club} onClose={() => setMedia(false)} />}
      </SafeAreaView>
    </Modal>
  );
}
const canEditMsg = (p, me) => p.username === me.username && (p.kind || 'text') === 'text' && Date.now() - new Date(p.created_at).getTime() <= 900000;
const pinText = (p) => { const k = p.kind || 'text'; return k === 'image' ? '📷 Fotoğraf' : k === 'sticker' ? 'Çıkartma' : k === 'file' ? fileMeta(p).name || 'Dosya' : p.body; };
function PinBar({ pin, onGo, onClose }) {
  return (
    <TouchableOpacity style={s.pinBar} onPress={onGo}>
      <Ionicons name="pin" size={18} color={C.accent} />
      <View style={{ flex: 1 }}><Text style={[s.itemSub, { color: C.accent }]}>{pin.username} · sabitlenen mesaj</Text><Text style={s.itemTitle} numberOfLines={1}>{pinText(pin)}</Text></View>
      <TouchableOpacity onPress={onClose} style={{ padding: 6 }}><Ionicons name="close" size={18} color={C.dim} /></TouchableOpacity>
    </TouchableOpacity>
  );
}
function ClubView({ club: club0, me, onBack }) {
  const [club, setClub] = useState(club0), [mem, setMem] = useState([]), [posts, setPosts] = useState([]), [pin, setPin] = useState(null), [txt, setTxt] = useState(''), [edit, setEdit] = useState(null);
  const [stk, setStk] = useState(false), [att, setAtt] = useState(false), [set, setSet] = useState(false), [big, setBig] = useState(null), [hl, setHl] = useState(null), [limit, setLimit] = useState(60), [jump, setJump] = useState(null);
  const listRef = useRef(null);
  const staff = club.owner === me.username || mem.some((m) => m.username === me.username && m.role === 'admin');
  const isM = mem.some((m) => m.username === me.username) || club.owner === me.username;
  const load = async () => {
    try {
      let r = await api(`club_members?club_id=eq.${club.id}&select=username,role`);
      if (!r.ok) r = await api(`club_members?club_id=eq.${club.id}&select=username`);
      const ms = await r.json(), ns = Array.isArray(ms) ? ms.map((m) => m.username) : [];
      const pr = ns.length ? await (await api(`profiles?username=in.(${ns.map(encodeURIComponent).join(',')})&select=username,total_km,car_brand,car_model`)).json() : [];
      setMem(ns.length ? ms.map((m) => ({ ...m, ...((Array.isArray(pr) ? pr : []).find((p) => p.username === m.username) || {}) })).sort((a, b) => (b.total_km || 0) - (a.total_km || 0)) : []);
      const base = `club_posts?club_id=eq.${club.id}&order=created_at.desc&limit=${limit}`;
      let q = await api(`${base}&select=id,username,body,created_at,kind,meta,pinned_at`);
      if (!q.ok) q = await api(`${base}&select=id,username,body,created_at,kind,meta`);
      if (!q.ok) q = await api(`${base}&select=id,username,body,created_at`);
      const pj = await q.json(); setPosts(Array.isArray(pj) ? pj : []);
      try {
        const pp = await (await api(`club_posts?club_id=eq.${club.id}&pinned_at=not.is.null&order=pinned_at.desc&limit=1&select=id,username,body,created_at,kind,meta,pinned_at`)).json();
        setPin(Array.isArray(pp) && pp[0] ? pp[0] : null);
      } catch {}
    } catch {}
  };
  useEffect(() => { load(); const id = setInterval(load, 15000); return () => clearInterval(id); }, [limit]);
  const goTo = (id) => {
    const i = posts.findIndex((x) => x.id === id);
    if (i < 0) { setJump(id); setLimit(400); return; }
    try { listRef.current && listRef.current.scrollToIndex({ index: i, animated: true, viewPosition: 0.5 }); } catch {}
    setHl(id); setTimeout(() => setHl(null), 1800);
  };
  useEffect(() => { if (jump && posts.some((p) => p.id === jump)) { const id = jump; setJump(null); setTimeout(() => goTo(id), 300); } }, [posts]);
  const send = async (row) => {
    const plain = !row.kind || row.kind === 'text';
    try {
      const r = await api('club_posts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ club_id: club.id, username: me.username, body: row.body || '', ...(plain ? {} : { kind: row.kind, media: row.media, meta: row.meta }) }) });
      if (!r.ok) AlertX.alert('Gönderilemedi', plain ? 'Bağlantını kontrol et.' : 'Sunucuda kulüp güncellemesi (SQL) eksik olabilir.');
      else load();
    } catch { AlertX.alert('Gönderilemedi', 'Bağlantını kontrol et.'); }
  };
  const saveEdit = async () => {
    const t = txt.trim();
    if (!t || !edit) return;
    if (!canEditMsg(edit, me)) { AlertX.alert('Süre doldu', 'Mesaj yalnızca gönderildikten sonraki 15 dakika içinde düzenlenebilir.'); setEdit(null); setTxt(''); return; }
    try {
      let r = await api(`club_posts?id=eq.${edit.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ body: t, meta: 'edited' }) });
      if (!r.ok) r = await api(`club_posts?id=eq.${edit.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ body: t }) });
      if (!r.ok) AlertX.alert('Düzenlenemedi', 'Bağlantını kontrol et.');
    } catch {}
    setEdit(null); setTxt(''); load();
  };
  const sendText = () => { if (edit) return saveEdit(); if (txt.trim()) { send({ body: txt.trim() }); setTxt(''); } };
  const delMsg = (p) => AlertX.alert('Mesaj silinsin mi?', 'Bu işlem geri alınamaz.', [{ text: 'Vazgeç', style: 'cancel' }, { text: 'Sil', style: 'destructive', onPress: async () => { try { await api(`club_posts?id=eq.${p.id}`, { method: 'DELETE' }); mcache.delete(p.id); } catch {} load(); } }]);
  const togglePin = async (p) => {
    try {
      const r = await api(`club_posts?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ pinned_at: p.pinned_at ? null : new Date().toISOString() }) });
      if (!r.ok) AlertX.alert('Sabitlenemedi', 'Sunucuda kulüp güncellemesi (SQL) eksik olabilir.');
    } catch {}
    load();
  };
  const msgMenu = (p) => {
    const k = p.kind || 'text', btns = [{ text: p.pinned_at ? 'Sabitlemeyi kaldır' : 'Sabitle', onPress: () => togglePin(p) }];
    if (canEditMsg(p, me)) btns.push({ text: 'Düzenle', onPress: () => { setEdit(p); setTxt(p.body); } });
    if (p.username === me.username || staff) btns.push({ text: 'Sil', style: 'destructive', onPress: () => delMsg(p) });
    btns.push({ text: 'Vazgeç', style: 'cancel' });
    AlertX.alert(p.username, k === 'text' ? String(p.body).slice(0, 80) + (p.username === me.username && !canEditMsg(p, me) ? '\n(Düzenleme süresi 15 dk idi)' : '') : '', btns);
  };
  const sendPhoto = async () => {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (r.canceled) return;
      const d = await shrink(r.assets[0].uri, 1000);
      if (!d || d.length > 1.4e6) return AlertX.alert('Fotoğraf gönderilemedi', 'Fotoğraf hazırlanamadı ya da çok büyük.');
      send({ kind: 'image', media: d });
    } catch {}
  };
  const sendFile = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (r.canceled) return;
      const a = r.assets[0];
      if ((a.size || 0) > 1.2e6) return AlertX.alert('Dosya çok büyük', 'En fazla 1,2 MB gönderebilirsin.');
      const b = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 });
      send({ kind: 'file', media: b, meta: JSON.stringify({ name: a.name, size: a.size, mime: a.mimeType }) });
    } catch { AlertX.alert('Dosya gönderilemedi', 'Tekrar dene.'); }
  };
  const join = async () => { try { await api('club_members', { method: 'POST', body: JSON.stringify({ club_id: club.id, username: me.username }) }); load(); } catch {} };
  const Bub = ({ p }) => {
    const mine = p.username === me.username, k = p.kind || 'text', lp = () => msgMenu(p);
    const body = k === 'image' ? <MediaImg id={p.id} style={{ width: 220, height: 220, borderRadius: 14 }} onPress={(u) => u && setBig(u)} onLong={lp} />
      : k === 'sticker' ? (p.meta === 'img' ? <MediaImg id={p.id} contain onLong={lp} style={{ width: 120, height: 120 }} /> : <Text style={{ fontSize: 56 }}>{p.body}</Text>)
      : k === 'file' ? (
        <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} onPress={() => openClubFile(p)} onLongPress={lp} delayLongPress={350}>
          <Ionicons name="document-text" size={28} color={C.accent} />
          <View style={{ maxWidth: 180 }}><Text style={s.itemTitle} numberOfLines={1}>{fileMeta(p).name || 'Dosya'}</Text><Text style={s.itemSub}>{fmtSize(fileMeta(p).size || 0)}</Text></View>
        </TouchableOpacity>
      ) : <Linkify text={p.body} onLong={lp} style={{ color: C.text, fontSize: 16 }} />;
    return (
      <TouchableOpacity activeOpacity={0.9} onLongPress={lp} delayLongPress={350} style={[s.bub, mine && { alignSelf: 'flex-end', backgroundColor: C.sel }, k === 'sticker' && { backgroundColor: 'transparent', padding: 0 }, hl === p.id && { borderWidth: 2, borderColor: C.accent }]}>
        <Text style={[s.itemSub, { color: C.accent, fontWeight: '700', marginBottom: 2 }]}>{p.username}</Text>
        {body}
        <Text style={[s.itemSub, { fontSize: 11, marginTop: 4, textAlign: 'right' }]}>{p.pinned_at ? '📌 ' : ''}{k === 'text' && p.meta === 'edited' ? 'düzenlendi · ' : ''}{fmtDate(p.created_at)}</Text>
      </TouchableOpacity>
    );
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={s.cvTop}>
        <TouchableOpacity onPress={onBack}><Ionicons name="chevron-back" size={28} color={C.accent} /></TouchableOpacity>
        <TouchableOpacity style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }} onPress={() => setSet(true)}>
          <Av club={club} size={40} />
          <View style={{ flex: 1 }}><Text style={s.itemTitle} numberOfLines={1}>{club.name}</Text><Text style={s.itemSub}>{mem.length} üye</Text></View>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setSet(true)} style={{ padding: 6 }}><Ionicons name="settings-outline" size={24} color={C.text} /></TouchableOpacity>
      </View>
      {pin && <PinBar pin={pin} onGo={() => goTo(pin.id)} onClose={() => togglePin(pin)} />}
      {!isM && <TouchableOpacity style={[s.btn, { margin: 14 }]} onPress={join}><Text style={s.btnText}>Kulübe katıl</Text></TouchableOpacity>}
      <FlatList ref={listRef} inverted data={posts} extraData={hl} keyExtractor={(p) => String(p.id)} contentContainerStyle={{ padding: 14 }}
        onScrollToIndexFailed={(info) => { listRef.current && listRef.current.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true }); setTimeout(() => { try { listRef.current && listRef.current.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 }); } catch {} }, 350); }}
        ListEmptyComponent={<Text style={[s.hint, { transform: [{ scaleY: -1 }] }]}>Henüz mesaj yok.</Text>} renderItem={({ item }) => <Bub p={item} />} />
      {isM && (
        <View>
          {edit && (
            <View style={s.editBar}>
              <Ionicons name="create" size={16} color={C.accent} />
              <Text style={[s.itemSub, { flex: 1 }]} numberOfLines={1}>Mesajı düzenliyorsun: {edit.body}</Text>
              <TouchableOpacity onPress={() => { setEdit(null); setTxt(''); }}><Ionicons name="close" size={18} color={C.dim} /></TouchableOpacity>
            </View>
          )}
          <View style={s.cvBar}>
            {!edit && <TouchableOpacity onPress={() => setAtt(true)} style={s.cvIc}><Ionicons name="attach" size={24} color={C.dim} /></TouchableOpacity>}
            <TextInput style={s.cvIn} value={txt} onChangeText={setTxt} placeholder="Mesaj yaz" placeholderTextColor={C.dim} maxLength={500} multiline />
            {!edit && <TouchableOpacity onPress={() => setStk(true)} style={s.cvIc}><Ionicons name="happy-outline" size={24} color={C.dim} /></TouchableOpacity>}
            <TouchableOpacity onPress={sendText} style={[s.cvIc, { backgroundColor: C.accent }]}><Ionicons name={edit ? 'checkmark' : 'send'} size={18} color="#06101F" /></TouchableOpacity>
          </View>
        </View>
      )}
      {att && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setAtt(false)}>
          <TouchableOpacity activeOpacity={1} style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'flex-end' }} onPress={() => setAtt(false)}>
            <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20 }}>
              <Text style={s.sec}>Ne göndermek istersin?</Text>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {[['image', 'Fotoğraf', sendPhoto], ['document-text', 'Dosya', sendFile]].map(([ic, l, fn]) => (
                  <TouchableOpacity key={l} style={[s.card, { alignItems: 'center', paddingVertical: 22 }]} onPress={() => { setAtt(false); setTimeout(fn, 250); }}>
                    <Ionicons name={ic} size={34} color={C.accent} /><Text style={[s.itemTitle, { marginTop: 8 }]}>{l}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
      {stk && <StickerSheet onClose={() => setStk(false)} onPick={(r) => { setStk(false); send(r); }} />}
      {set && <ClubSettings club={club} me={me} mem={mem} setClub={setClub} onClose={() => setSet(false)} onChanged={load} onLeft={() => { setSet(false); onBack(); }} />}
      {big && <Modal visible transparent animationType="fade" onRequestClose={() => setBig(null)}><TouchableOpacity activeOpacity={1} style={[s.modalBg, { backgroundColor: '#000' }]} onPress={() => setBig(null)}><Image source={{ uri: big }} style={{ width: '100%', height: '80%' }} resizeMode="contain" /></TouchableOpacity></Modal>}
    </View>
  );
}
function ClubsScreen({ me, onClose }) {
  const [clubs, setClubs] = useState([]), [mine, setMine] = useState([]), [sel, setSel] = useState(null), [q, setQ] = useState(''), [mk, setMk] = useState(false), [nm, setNm] = useState(''), [ab, setAb] = useState('');
  const load = async () => {
    if (!online) return;
    try {
      let r = await api('clubs?select=id,name,about,vtype,owner,photo&order=created_at.desc&limit=100');
      if (!r.ok) r = await api('clubs?select=id,name,about,vtype,owner&order=created_at.desc&limit=100');
      const c = await r.json();
      setClubs(Array.isArray(c) ? c : []);
      const m = await (await api(`club_members?username=eq.${me.username}&select=club_id`)).json();
      setMine(Array.isArray(m) ? m.map((x) => x.club_id) : []);
    } catch {}
  };
  useEffect(() => { load(); }, []);
  const create = async () => {
    const n = nm.trim();
    if (n.length < 3) return AlertX.alert('Kulüp adı en az 3 karakter olmalı');
    try {
      const r = await api('clubs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name: n, about: ab.trim(), vtype: me.car?.vtype || 'car', owner: me.username }) });
      if (r.status === 409) return AlertX.alert('Bu kulüp adı alınmış');
      const [c] = await r.json();
      let m = await api('club_members', { method: 'POST', body: JSON.stringify({ club_id: c.id, username: me.username, role: 'owner' }) });
      if (!m.ok) await api('club_members', { method: 'POST', body: JSON.stringify({ club_id: c.id, username: me.username }) });
      setMk(false); setNm(''); setAb(''); load(); setSel(c);
    } catch { AlertX.alert('Kulüp oluşturulamadı', 'Bağlantını ve sunucu ayarlarını kontrol et.'); }
  };
  const list = clubs.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        {!online ? (
          <View style={{ padding: 20 }}><Text style={s.title}>Kulüpler</Text><Text style={s.itemSub}>Kulüpler için sunucu bağlantısı gerekli.</Text><TouchableOpacity onPress={onClose}><Text style={{ color: C.accent, padding: 16 }}>Kapat</Text></TouchableOpacity></View>
        ) : sel ? (
          <ClubView club={sel} me={me} onBack={() => { setSel(null); load(); }} />
        ) : (
          <ScrollView contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={s.title}>Kulüpler</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color={C.text} /></TouchableOpacity></View>
            <TextInput style={[s.input, { marginTop: 0, marginBottom: 12 }]} value={q} onChangeText={setQ} placeholder="Kulüp ara" placeholderTextColor={C.dim} />
            <TouchableOpacity style={[s.btn, { marginTop: 0, marginBottom: 12 }]} onPress={() => setMk(!mk)}><Text style={s.btnText}>{mk ? 'Vazgeç' : 'Yeni kulüp kur'}</Text></TouchableOpacity>
            {mk && (
              <View style={[s.card, { marginBottom: 12, flexBasis: undefined }]}>
                <TextInput style={[s.input, { marginTop: 0 }]} value={nm} onChangeText={setNm} placeholder="Kulüp adı" placeholderTextColor={C.dim} maxLength={40} />
                <TextInput style={s.input} value={ab} onChangeText={setAb} placeholder="Kısa açıklama (marka, şehir, tarz...)" placeholderTextColor={C.dim} maxLength={140} />
                <TouchableOpacity style={s.btn} onPress={create}><Text style={s.btnText}>Kur</Text></TouchableOpacity>
              </View>
            )}
            {list.length === 0 && <Text style={s.hint}>Henüz kulüp yok. İlkini sen kur.</Text>}
            {list.map((c) => (
              <TouchableOpacity key={c.id} style={[s.item, { flexDirection: 'row', alignItems: 'center', gap: 12 }]} onPress={() => setSel(c)}>
                <Av club={c} size={46} />
                <View style={{ flex: 1 }}>
                  <Text style={s.itemTitle}>{c.name}{mine.includes(c.id) ? '  ✓' : ''}</Text>
                  <Text style={s.itemSub} numberOfLines={1}>{c.vtype === 'moto' ? 'Motor' : 'Araba'}{c.about ? ' · ' + c.about : ''}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const MODS = [
  ['Renk', [['Stok', ''], ['Mat siyah', 'matte black paint'], ['Beyaz', 'pearl white paint'], ['Kırmızı', 'candy red paint'], ['Mavi', 'metallic blue paint'], ['Mat gri', 'matte grey wrap'], ['Turuncu', 'orange paint'], ['Yeşil', 'racing green paint']]],
  ['Jant', [['Stok', ''], ['Siyah jant', 'black alloy wheels'], ['Altın jant', 'gold forged wheels'], ['Büyük krom', 'large chrome wheels']]],
  ['Gövde kiti', [['Stok', ''], ['Geniş kasa', 'wide body kit'], ['Spoyler', 'big rear wing spoiler'], ['Karbon parça', 'carbon fiber aero parts']]],
  ['Duruş', [['Stok', ''], ['Alçaltılmış', 'lowered stance'], ['Yükseltilmiş', 'lifted off-road stance']]],
  ['Ortam', [['Aynı kalsın', ''], ['Gün batımı yol', 'on a coastal road at sunset'], ['Gece şehir', 'in a neon city at night'], ['Pist', 'on a race track'], ['Stüdyo', 'in a clean photo studio']]],
];
const SHARED = CFG.AI_KEY || '', AI_DAILY = CFG.AI_DAILY || 8, AIU = '@apexdrive_aiuse';
const AIK = '@apexdrive_aikey';
let AIM = null;
async function aiModel(key) {
  if (AIM) return AIM;
  const j = await (await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } })).json();
  if (j.error) { const e = new Error(j.error.message || 'anahtar'); e.code = j.error.code; throw e; }
  const ok = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /image/i.test(m.name) && !/imagen/i.test(m.name));
  const pick = ok.find((m) => /flash/i.test(m.name) && !/preview/i.test(m.name)) || ok.find((m) => /flash/i.test(m.name)) || ok[0];
  if (!pick) throw new Error('Bu anahtar için görsel düzenleme modeli bulunamadı.');
  AIM = pick.name.replace('models/', '');
  return AIM;
}
async function aiEdit(key, b64, prompt) {
  const model = await aiModel(key);
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }) });
  const j = await r.json();
  if (!r.ok) { const e = new Error((j.error && j.error.message) || 'hata'); e.code = r.status; throw e; }
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const im = parts.find((p) => p.inlineData || p.inline_data);
  if (!im) throw new Error((parts.find((p) => p.text) || {}).text || 'Görsel üretilemedi.');
  const d = im.inlineData || im.inline_data;
  return { mime: d.mimeType || d.mime_type || 'image/png', data: d.data };
}
const aiErr = (e) => (e.code === 400 && /key/i.test(e.message) ? 'Anahtar geçersiz görünüyor. Kontrol edip yeniden gir.' : e.code === 403 ? 'Bu anahtarla görsel düzenlemeye izin yok (ya da bölge kısıtı var).' : e.code === 429 ? 'Ücretsiz kota doldu. Biraz bekleyip tekrar dene (kota Google tarafından belirlenir).' : String(e.message || 'Bir sorun oluştu').slice(0, 160));
function ModStudio({ me, onClose }) {
  const [key, setKey] = useState(null), [kin, setKin] = useState(''), [sel, setSel] = useState({}), [extra, setExtra] = useState(''), [orig, setOrig] = useState(null), [res, setRes] = useState(null), [busy, setBusy] = useState(false), [err, setErr] = useState(''), [after, setAfter] = useState(true), [used, setUsed] = useState(0);
  const car = me.car || {}, word = car.vtype === 'moto' ? 'motorcycle' : 'car';
  useEffect(() => {
    if (SHARED) { setKey(SHARED); AsyncStorage.getItem(AIU).then((v) => { const u = v ? JSON.parse(v) : {}; setUsed(u.d === new Date().toDateString() ? u.n : 0); }).catch(() => {}); return; }
    AsyncStorage.getItem(AIK).then((v) => setKey(v || '')).catch(() => setKey(''));
  }, []);
  const saveKey = () => { const k = kin.trim(); if (k.length < 20) return AlertX.alert('Anahtar eksik', 'Google AI Studio anahtarının tamamını yapıştır.'); AIM = null; AsyncStorage.setItem(AIK, k).catch(() => {}); setKey(k); };
  const pick = async () => {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6, base64: true });
      if (r.canceled) return;
      if (r.assets[0].base64.length > 6e6) return AlertX.alert('Fotoğraf çok büyük', 'Daha küçük bir fotoğraf seç.');
      setOrig(r.assets[0].base64); setRes(null); setErr('');
    } catch { AlertX.alert('Fotoğraf seçilemedi', 'Galeri iznini kontrol et.'); }
  };
  const run = async () => {
    const parts = MODS.map(([k, o]) => o[sel[k] || 0][1]).filter(Boolean);
    if (!orig) return AlertX.alert('Önce fotoğraf seç', `Düzenlenecek ${word === 'car' ? 'araç' : 'motor'} fotoğrafını ekle.`);
    if (!parts.length && !extra.trim()) return AlertX.alert('Bir değişiklik seç', 'Renk, jant gibi bir seçenek seç ya da ek istek yaz.');
    if (SHARED && used >= AI_DAILY) return AlertX.alert('Günlük hakkın bitti', 'Bugün için tüm düzenleme haklarını kullandın. Yarın tekrar dene.');
    setBusy(true); setErr('');
    try {
      const prompt = `Edit this photo of a ${word}. Keep the same ${word}, camera angle, framing and number plate; change only what is requested. Apply: ${parts.join(', ')}${extra.trim() ? '. ' + extra.trim() : ''}. Photorealistic, natural lighting and reflections.`;
      setRes(await aiEdit(key, orig, prompt)); setAfter(true);
      if (SHARED) { const n = used + 1; setUsed(n); AsyncStorage.setItem(AIU, JSON.stringify({ d: new Date().toDateString(), n })).catch(() => {}); }
    } catch (e) { setErr(aiErr(e)); }
    setBusy(false);
  };
  const share = async () => { try { const f = FileSystem.cacheDirectory + 'apex-mod.png'; await FileSystem.writeAsStringAsync(f, res.data, { encoding: FileSystem.EncodingType.Base64 }); await Sharing.shareAsync(f); } catch { AlertX.alert('Paylaşılamadı', 'Görsel kaydedilemedi.'); } };
  const shown = res && after ? `data:${res.mime};base64,${res.data}` : orig ? `data:image/jpeg;base64,${orig}` : null;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={s.title}>Modifiye (AI)</Text><TouchableOpacity onPress={onClose}><Ionicons name="close" size={28} color={C.text} /></TouchableOpacity></View>
          {key === null ? <ActivityIndicator color={C.accent} /> : !key ? (
            <View style={[s.card, { flexBasis: undefined }]}>
              <Text style={s.itemTitle}>Google AI anahtarı gerekli</Text>
              <Text style={[s.itemSub, { marginTop: 6 }]}>Fotoğrafını düzenleyen yapay zeka için kendi ücretsiz Google AI Studio anahtarını kullanırsın. Kota sana ait olur, anahtar sadece bu telefonda saklanır.{'\n\n'}1) Aşağıdaki düğmeden siteyi aç{'\n'}2) Google hesabınla gir, "Create API key" de{'\n'}3) Anahtarı kopyalayıp buraya yapıştır</Text>
              <TouchableOpacity style={[s.btn, { backgroundColor: C.line }]} onPress={() => Linking.openURL('https://aistudio.google.com/apikey')}><Text style={[s.btnText, { color: C.text }]}>Anahtar al</Text></TouchableOpacity>
              <TextInput style={s.input} value={kin} onChangeText={setKin} placeholder="Anahtarı yapıştır" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false} />
              <TouchableOpacity style={s.btn} onPress={saveKey}><Text style={s.btnText}>Kaydet</Text></TouchableOpacity>
            </View>
          ) : (
            <View>
              <Text style={s.itemSub}>{car.brand} {car.model} {car.year}{SHARED ? `  ·  Bugün kalan hak: ${Math.max(0, AI_DAILY - used)}` : ''}</Text>
              <TouchableOpacity style={[s.btn, { backgroundColor: C.card, marginTop: 12 }]} onPress={pick}><Text style={[s.btnText, { color: C.accent }]}>{orig ? 'Fotoğrafı değiştir' : 'Fotoğraf seç'}</Text></TouchableOpacity>
              {shown && <Image source={{ uri: shown }} style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: 24, marginTop: 12, backgroundColor: C.card }} resizeMode="contain" />}
              {res && <View style={{ alignItems: 'center' }}><Chips opts={[['Önce', false], ['Sonra', true]]} val={after} onPick={setAfter} /></View>}
              {MODS.map(([k, o]) => (<View key={k}><Text style={[s.itemSub, { marginTop: 14 }]}>{k}</Text><Chips opts={o.map(([l], i) => [l, i])} val={sel[k] || 0} onPick={(i) => setSel({ ...sel, [k]: i })} /></View>))}
              <TextInput style={s.input} value={extra} onChangeText={setExtra} placeholder="Ek istek (ör. mat siyah kaput, neon altı)" placeholderTextColor={C.dim} />
              <TouchableOpacity style={s.btn} onPress={run} disabled={busy}><Text style={s.btnText}>{busy ? 'Düzenleniyor...' : 'Düzenle'}</Text></TouchableOpacity>
              {busy && <ActivityIndicator color={C.accent} style={{ marginTop: 12 }} />}
              {!!err && <Text style={[s.hint, { color: '#FF6B6B' }]}>{err}</Text>}
              {res && !busy && <TouchableOpacity style={[s.btn, { backgroundColor: C.card }]} onPress={share}><Text style={[s.btnText, { color: C.accent }]}>Sonucu paylaş</Text></TouchableOpacity>}
              {!SHARED && <TouchableOpacity onPress={() => { AsyncStorage.removeItem(AIK).catch(() => {}); AIM = null; setKey(''); }}><Text style={[s.hint, { color: C.accent }]}>Anahtarı sil</Text></TouchableOpacity>}
              <Text style={s.hint}>Sonuç yapay zeka yorumudur, birebir gerçek olmayabilir. Ücretsiz kotanın sınırını Google belirler.</Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function SettingsModal({ prefs, setPrefs, onClose, autoCheck, onOpenMod }) {
  const [st, setSt] = useState('idle');
  const [rel, setRel] = useState(null);
  const [sv, setSv] = useState('');
  const ping = async () => {
    if (!online) return setSv('Sunucu adresi ayarlı değil (config.js boş).');
    setSv('Deneniyor...');
    const res = await Promise.all(['profiles', 'clubs', 'club_members', 'club_posts', 'stories', 'presence'].map(async (n) => { try { return [n, (await api(`${n}?select=*&limit=1`)).status]; } catch { return [n, 0]; } }));
    const bad = res.filter(([, c]) => c !== 200);
    setSv(bad.length ? 'Sorun var: ' + bad.map(([n, c]) => `${n} (${c || 'ulaşılamadı'})`).join(', ') + '. 404 = tablo yok, 401/403 = anahtar ya da izin, ulaşılamadı = adres yanlış.' : 'Sunucu hazır ✓ Tüm tablolara erişilebiliyor.');
  };
  const check = async () => {
    if (!GH_REPO) return setSt('norepo');
    setSt('checking');
    try {
      const j = await (await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`)).json();
      const n = parseInt(String(j.tag_name).replace(/\D/g, ''), 10), apk = (j.assets || []).find((a) => a.name.endsWith('.apk'));
      if (n > BUILD && apk) { setRel({ n, url: apk.browser_download_url, page: j.html_url }); setSt('new'); } else setSt('latest');
    } catch { setSt('err'); }
  };
  const update = async () => {
    if (Platform.OS !== 'android') return Linking.openURL(rel.page);
    setSt('busy');
    try {
      const res = await FileSystem.downloadAsync(rel.url, FileSystem.cacheDirectory + 'apexdrive-update.apk');
      const uri = await FileSystem.getContentUriAsync(res.uri);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: uri, flags: 1, type: 'application/vnd.android.package-archive' });
    } catch { Linking.openURL(rel.url); }
    setSt('new');
  };
  useEffect(() => { if (autoCheck) check(); }, []);
  const msg = { idle: '', checking: 'Kontrol ediliyor...', latest: 'En son sürümü kullanıyorsun.', err: 'Kontrol edilemedi. İnternetini kontrol et.', norepo: 'Güncelleme adresi tanımlı değil. Derleme dosyasını güncelleyip yeniden derlemen gerekiyor.', busy: 'İndiriliyor, kurulum ekranı açılacak...', new: rel ? `Yeni sürüm hazır (#${rel.n}).` : '' }[st];
  const Box = ({ title, sub, children }) => <View style={[s.card, { marginBottom: 12, flexBasis: undefined }]}><Text style={s.itemTitle}>{title}</Text>{!!sub && <Text style={[s.itemSub, { marginTop: 4 }]}>{sub}</Text>}{children}</View>;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}><Text style={s.title}>Ayarlar</Text><TouchableOpacity onPress={onClose} style={{ padding: 6 }}><Ionicons name="close" size={28} color={C.text} /></TouchableOpacity></View>
          <Box title="Görünüm"><Chips opts={[['Sistem', 'system'], ['Karanlık', 'dark'], ['Aydınlık', 'light']]} val={prefs.theme} onPick={(v) => setPrefs({ ...prefs, theme: v })} /></Box>
          <Box title="Sürüş yeniden izleme kaydı" sub="Seçilen günden eski sürüşlerin rota kaydı silinir, istatistiklerin ve bölgelerin kalır."><Chips opts={[7, 14, 21, 30].map((d) => [`${d} gün`, d])} val={prefs.keepDays} onPick={(v) => setPrefs({ ...prefs, keepDays: v })} /></Box>
          <Box title="Yakındakilere görün" sub="Açıksan yakındaki sürücüler seni yaklaşık konumunla (≈1 km) hikaye haritasında görür."><Chips opts={[['Kapalı', false], ['Açık', true]]} val={prefs.visible} onPick={(v) => setPrefs({ ...prefs, visible: v })} /></Box>
          <Box title="Gazlama bildirimleri" sub="Günde 3 kez, rastgele saatlerde (10:00–21:30 arası) sürüşe çıkmak ister misin diye sorar. O gün sürüş yaptıysan atlanır."><Chips opts={[['Kapalı', 0], ['Açık', 1]]} val={prefs.daily ? 1 : 0} onPick={(v) => setPrefs({ ...prefs, daily: v })} /></Box>
          <Box title="Sunucu" sub="Sıralama, kulüpler ve hikayeler için.">
            {!!sv && <Text style={[s.itemSub, { marginTop: 10, color: C.text }]}>{sv}</Text>}
            <TouchableOpacity style={s.btn} onPress={ping}><Text style={s.btnText}>Bağlantıyı dene</Text></TouchableOpacity>
          </Box>
          <Box title="Güncelleme" sub={`Kurulu sürüm: derleme #${BUILD}${RP.SHA ? ' · ' + RP.SHA : ''}`}>
            {!!msg && <Text style={[s.itemSub, { marginTop: 10, color: C.text }]}>{msg}</Text>}
            <TouchableOpacity style={s.btn} disabled={st === 'checking' || st === 'busy'} onPress={st === 'new' ? update : check}><Text style={s.btnText}>{st === 'new' ? 'Güncelle' : 'Güncellemeleri kontrol et'}</Text></TouchableOpacity>
            {Platform.OS === 'android' && <Text style={[s.hint, { textAlign: 'left' }]}>İlk güncellemede telefon "bu kaynaktan kuruluma izin ver" diye sorabilir.</Text>}
          </Box>
          <TouchableOpacity style={[s.item, { flexDirection: 'row', alignItems: 'center', gap: 12 }]} onPress={onOpenMod}>
            <Ionicons name="color-wand" size={24} color={C.accent} /><Text style={[s.itemTitle, { flex: 1 }]}>Modifiye (AI)</Text><Ionicons name="chevron-forward" size={20} color={C.dim} />
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ---- Kendi uyarı penceremiz (telefonun varsayılan uyarısı yerine) ----
const Dlg = { show: null };
const ME = { car: '' };
const AlertX = { alert: (title, msg, buttons) => { if (Dlg.show) Dlg.show({ title, msg, buttons }); } };
function DialogHost({ dlg, onClose }) {
  const last = useRef(null);
  if (dlg) last.current = dlg;
  const d = dlg || last.current || {}, btns = d.buttons && d.buttons.length ? d.buttons : [{ text: 'Tamam' }];
  const kind = (b, i) => (b.style === 'destructive' ? 'd' : b.style === 'cancel' || (!b.style && i < btns.length - 1) ? 'c' : 'p');
  const BG = { d: '#FF453A22', c: C.line, p: C.accent }, FG = { d: '#FF6B6B', c: C.text, p: '#06101F' };
  return (
    <Modal visible={!!dlg} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.dlgBg}>
        <View style={s.dlg}>
          <Text style={s.dlgT}>{d.title}</Text>
          {!!d.msg && <Text style={s.dlgM}>{d.msg}</Text>}
          <View style={{ flexDirection: btns.length > 2 ? 'column' : 'row', gap: 10, marginTop: 20 }}>
            {btns.map((b, i) => {
              const k = kind(b, i);
              return (
                <TouchableOpacity key={i} style={[s.dlgB, { backgroundColor: BG[k] }, btns.length > 2 && { flex: 0, minHeight: 46 }]} onPress={() => { onClose(); b.onPress && b.onPress(); }}>
                  <Text style={[s.dlgBT, { color: FG[k] }]}>{b.text}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---- Fotoğraf görüntüleyici ----
function PhotoViewer({ photos, start, onClose, onDelete }) {
  const { width: W, height: H } = Dimensions.get('window');
  const [i, setI] = useState(start);
  useEffect(() => { if (photos.length === 0) onClose(); }, [photos.length]);
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <FlatList data={photos} horizontal pagingEnabled showsHorizontalScrollIndicator={false} initialScrollIndex={Math.min(start, Math.max(0, photos.length - 1))} keyExtractor={(u) => u}
          getItemLayout={(_, k) => ({ length: W, offset: W * k, index: k })}
          onMomentumScrollEnd={(e) => setI(Math.round(e.nativeEvent.contentOffset.x / W))}
          renderItem={({ item }) => <View style={{ width: W, height: H, justifyContent: 'center' }}><Image source={{ uri: item }} style={{ width: W, height: H * 0.8 }} resizeMode="contain" /></View>} />
        <View style={s.pvTop}>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>{Math.min(i, photos.length - 1) + 1} / {photos.length}</Text>
          <View style={{ flexDirection: 'row', gap: 22 }}>
            <TouchableOpacity onPress={() => photos[i] && onDelete(photos[i])}><Ionicons name="trash-outline" size={26} color="#fff" /></TouchableOpacity>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={30} color="#fff" /></TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---- Yol projeksiyonu paylaşım şablonları ----
const GCOL = ['#FFB02E', '#6EC7C7', '#FF453A', '#BF5AF2', '#34C759', '#FFFFFF'];
const spBar = (route, n = 36) => Array.from({ length: n }, (_, j) => spColor(route[Math.min(route.length - 1, Math.floor((j / n) * route.length))]?.v));
function flatRoute(route, w, h) {
  const k = Math.cos(route[0].latitude * Math.PI / 180), step = Math.ceil(route.length / 200);
  const pts = route.filter((_, i) => i % step === 0 || i === route.length - 1);
  const xs = pts.map((p) => p.longitude * k), ys = pts.map((p) => -p.latitude), n = pts.length - 1;
  // rota, başlangıç altta bitiş yukarıda olacak şekilde döndürülür
  const a = Math.atan2(xs[n] - xs[0], -(ys[n] - ys[0])), ca = Math.cos(a), sa = Math.sin(a);
  const R = pts.map((_, i) => [xs[i] * ca + ys[i] * sa, -xs[i] * sa + ys[i] * ca]);
  const x0 = Math.min(...R.map((p) => p[0])), y0 = Math.min(...R.map((p) => p[1]));
  const dx = Math.max(...R.map((p) => p[0])) - x0 || 1e-9, dy = Math.max(...R.map((p) => p[1])) - y0 || 1e-9;
  const sc = Math.min((w - 30) / dx, (h - 30) / dy), ox = (w - dx * sc) / 2, oy = (h - dy * sc) / 2;
  return R.map((p) => [ox + (p[0] - x0) * sc, oy + (p[1] - y0) * sc]);
}
function SceneBg({ w, h, v }) {
  const c = [['#FF9A3C', '#5B2A6E'], ['#27507A', '#0B1020']][v] || ['#FF9A3C', '#5B2A6E'];
  return (
    <Svg width={w} height={h} style={StyleSheet.absoluteFill}>
      <Defs><LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={c[1]} /><Stop offset="0.4" stopColor={c[0]} /><Stop offset="0.41" stopColor="#17171C" /><Stop offset="1" stopColor="#09090C" /></LinearGradient></Defs>
      <Rect width={w} height={h} fill="url(#sky)" />
      <Path d={`M0 ${h * 0.41} L${w * 0.18} ${h * 0.31} L${w * 0.4} ${h * 0.39} L${w * 0.62} ${h * 0.28} L${w * 0.84} ${h * 0.38} L${w} ${h * 0.33} L${w} ${h * 0.41} Z`} fill="#0E0E16" />
    </Svg>
  );
}
function RoadCard({ t, W, H, tpl, photo, scene, gc, dim, names, persp }) {
  const GW = 340, GH = 374, RW = GW * 0.86, RH = GH * 0.4, k = Math.min((W * 0.94) / GW, (H * 0.93) / GH);
  const end = new Date(t.start + t.duration * 1000);
  const hm = end.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const arrive = `${hm}, ${end.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  const km = t.dist < 10 ? t.dist.toFixed(1) : Math.round(t.dist), sp = Math.round(t.max), avg = Math.round(Math.min(t.avg, t.max));
  const P = t.route && t.route.length > 1 ? flatRoute(t.route, RW, RH) : null;
  const d = P ? P.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') : '';
  const at = (f) => P[Math.round(f * (P.length - 1))];
  const gold = { color: gc, fontStyle: 'italic' }, soft = { color: gc + 'DD', fontStyle: 'italic' };
  const cm = { fill: 'none', strokeLinejoin: 'round', strokeLinecap: 'round' };
  const p0 = P && P[0];
  return (
    <>
      {photo ? <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <SceneBg w={W} h={H} v={scene} />}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: `rgba(0,0,0,${[0, 0.25, 0.5][dim]})` }]} />
      <View style={{ position: 'absolute', left: (W - GW) / 2, top: H - 4 - (GH * k) / 2 - GH / 2, width: GW, height: GH, transform: persp ? [{ perspective: 800 }, { rotateX: '38deg' }, { scale: k }] : [{ scale: k }] }}>
        {P && (
          <View style={{ position: 'absolute', left: (GW - RW) / 2, top: 0, width: RW, height: RH }}>
            <Svg width={RW} height={RH}>
              <Path d={d} stroke={gc} strokeWidth={20} opacity={0.14} {...cm} />
              <Path d={d} stroke={gc} strokeWidth={12} opacity={0.3} {...cm} />
              <Path d={d} stroke={gc} strokeWidth={6} {...cm} />
              <Path d={d} stroke="#FFF3D6" strokeWidth={2} {...cm} />
              {tpl === 0
                ? <Polygon points={`${p0[0]},${p0[1] - 16} ${p0[0] + 12},${p0[1] + 10} ${p0[0]},${p0[1] + 4} ${p0[0] - 12},${p0[1] + 10}`} fill="#0008" stroke="#fff" strokeWidth={2} />
                : <Circle cx={p0[0]} cy={p0[1]} r={9} fill="#0008" stroke="#fff" strokeWidth={2} />}
            </Svg>
            {[0.3, 0.55, 0.8, 1].map((f, j) => (names[j + 1] ? <Text key={j} style={[s.rcLbl, soft, { left: at(f)[0] + 8, top: at(f)[1] - 8 }]}>{names[j + 1]}</Text> : null))}
            {names[0] ? <Text style={[s.rcLbl, soft, { left: Math.max(0, p0[0] - 36), top: p0[1] + 14 }]}>{names[0]}</Text> : null}
          </View>
        )}
        {tpl === 0 ? (
          <View style={{ position: 'absolute', left: 0, top: GH * 0.44, width: GW }}>
            <View style={[s.rcBox, { borderColor: gc + 'AA', alignSelf: 'flex-start', minWidth: GW * 0.5 }]}>
              <Text style={[s.rcBig, gold]}>{fmtDur(t.duration)}</Text>
              <Text style={[s.rcMid, soft]}>{km} km</Text>
              <Text style={[s.rcSm, soft]}>Maks. hız {sp} km/s</Text>
            </View>
            <View style={[s.rcSign, { marginTop: 10 }]}><Text style={s.rcSignT}>{sp}</Text></View>
            <Text style={[s.rcMid, soft, { marginTop: 8 }]}>Varış · {arrive}</Text>
            {P && <View style={s.rcBar}>{spBar(t.route).map((c, j) => <View key={j} style={{ flex: 1, backgroundColor: c }} />)}</View>}
            <Text style={[s.rcMid, soft, { marginTop: 8 }]}>{fmtDur(t.duration)} · {km} km</Text>
          </View>
        ) : (
          <View style={{ position: 'absolute', left: 0, top: GH * 0.43, width: GW }}>
            <View style={[s.rcBox, { borderColor: gc + '88', alignSelf: 'flex-start' }]}>
              <Text style={[s.rcMid, gold]}>{fmtDur(t.duration)}</Text>
              <Text style={[s.rcSm, soft]}>Maks. hız {sp} km/s</Text>
            </View>
            <View style={[s.rcPanel, { borderColor: gc + '88', marginTop: 14 }]}>
              {[[`${km} km`, 'Mesafe'], [fmtDur(t.duration), 'Süre'], [hm, 'Varış']].map(([v, l], j) => (
                <View key={j} style={{ flex: 1, alignItems: 'center' }}><Text style={[s.rcBig2, gold]}>{v}</Text><Text style={[s.rcSm, soft]}>{l}</Text></View>
              ))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 }}>
              <View style={[s.rcGauge, { borderColor: gc + 'AA' }]}><Text style={[s.rcBig2, gold]}>{avg}</Text><Text style={[s.rcSm, soft]}>km/s</Text></View>
              <View style={[s.rcPill, { flex: 1 }]}><Text style={[s.rcMid, soft]} numberOfLines={1}>{ME.car || 'Ortalama hız'}</Text></View>
              <View style={[s.rcTile, { borderColor: gc }]}><Text style={[s.rcMid, gold]}>ApexDrive</Text></View>
            </View>
          </View>
        )}
      </View>
    </>
  );
}

// ---- Araç belgeleri: başlangıç tarihi + süre -> bitiş otomatik ----
const DEFY = { sigorta: 1, kasko: 1, vize: 2 };
const addYears = (d, n) => { const x = new Date(d); x.setFullYear(x.getFullYear() + n); return x; };
const fmtOut = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

function Detail({ t, onBack, onDelete, onUpdate }) {
  const [sharing, setSharing] = useState(false), [sn, setSn] = useState(false);
  const snap = async () => {
    if (t.snapped && t.raw) return onUpdate(t.id, { route: t.raw, snapped: false, raw: null });
    setSn(true);
    const r = await snapRoute(t.route);
    setSn(false);
    if (!r) return AlertX.alert('Yola oturtulamadı', 'İnternet yok ya da bu yol haritada kayıtlı değil (ör. toprak yol). Rota olduğu gibi kaldı.');
    onUpdate(t.id, { route: r, snapped: true, raw: t.route.filter((_, i) => i % Math.ceil(t.route.length / 400) === 0) });
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
      <TouchableOpacity onPress={onBack}><Text style={{ color: C.accent, marginBottom: 12 }}>Geri</Text></TouchableOpacity>
      <Text style={s.h1}>{fmtDate(t.start)}</Text>
      {t.route?.length > 1 ? <ReplayBox t={t} /> : <Text style={[s.hint, { marginBottom: 12 }]}>Bu sürüşün rota kaydı, saklama süresi dolduğu için silindi.</Text>}
      {t.route?.length > 4 && <TouchableOpacity style={[s.btn, { backgroundColor: C.card, marginTop: 0, marginBottom: 12 }]} onPress={snap} disabled={sn}><Text style={[s.btnText, { color: C.accent }]}>{sn ? 'Yola oturtuluyor...' : t.snapped ? 'Ham rotaya dön' : 'Rotayı yola oturt'}</Text></TouchableOpacity>}
      <SpeedDist route={t.route} />
      <TripStats t={t} />
      <TouchableOpacity style={s.btn} onPress={() => setSharing(true)}><Text style={s.btnText}>Sürüşü paylaş</Text></TouchableOpacity>
      <TouchableOpacity style={[s.btn, { backgroundColor: C.card, marginTop: 10 }]} onPress={onDelete}>
        <Text style={[s.btnText, { color: '#FF6B6B' }]}>Sürüşü sil</Text>
      </TouchableOpacity>
      {sharing && <ShareSheet t={t} onClose={() => setSharing(false)} />}
    </ScrollView>
  );
}

function AppInner() {
  const sysScheme = useColorScheme();
  const [prefs, setPrefs] = useState({ theme: 'system', keepDays: 14, visible: false, daily: 1 });
  const eff = prefs.theme === 'system' ? (sysScheme === 'light' ? 'light' : 'dark') : prefs.theme;
  if (curTheme !== eff) { curTheme = eff; C = eff === 'light' ? LIGHT : DARK; s = mk(); }
  const [menu, setMenu] = useState(false), [screen, setScreen] = useState(null), [cellStore, setCellStore] = useState([]);
  const pLoaded = useRef(false);
  const [pReady, setPReady] = useState(false);
  const [dlg, setDlg] = useState(null);
  Dlg.show = setDlg;
  const [settingsOpen, setSettingsOpen] = useState(false), [autoUpd, setAutoUpd] = useState(false);
  const [tab, setTab] = useState('drive');
  const [profile, setProfile] = useState(undefined);
  const [friends, setFriends] = useState([]);
  const [shareTrip, setShareTrip] = useState(null);
  useEffect(() => { if (profile) ensureProfile(profile); }, [profile?.username]);
  const [vdocs, setVdocs] = useState({});
  const [rem, setRem] = useState({ start: 30, freq: 1, hour: 9 });
  const vLoaded = useRef(false);
  const [trips, setTrips] = useState([]);
  const [regions, setRegions] = useState({});
  const [cur, setCur] = useState(null);
  const [ask, setAsk] = useState(null);
  const [on, setOn] = useState(false);
  const [live, setLive] = useState({ speed: 0, dist: 0, max: 0, g: 0, secs: 0 });
  const [route, setRoute] = useState([]);
  const regionsRef = useRef({}), lastGeo = useRef(null), onRef = useRef(false), pending = useRef(null), sub = useRef(null), checkRef = useRef(() => {});

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => v && setTrips(JSON.parse(v))).catch(() => {});
    AsyncStorage.getItem(FKEY).then((v) => v && setFriends(JSON.parse(v))).catch(() => {});
    AsyncStorage.getItem(PKEY).then((v) => setProfile(v ? JSON.parse(v) : null)).catch(() => setProfile(null));
    AsyncStorage.getItem(RKEY).then((v) => { if (v) { regionsRef.current = JSON.parse(v); setRegions(regionsRef.current); } }).catch(() => {});
    Location.requestForegroundPermissionsAsync().catch(() => {});
    onTick = () => {
      setLive({ speed: R.last.v * 3.6, dist: R.dist, max: R.max, g: R.maxG, secs: (Date.now() - R.t0) / 1000 });
      setRoute(R.route.slice());
      checkRef.current(R.last.c.latitude, R.last.c.longitude);
    };
    return () => { onTick = null; };
  }, []);

  const saveRegions = (n) => { regionsRef.current = n; setRegions(n); AsyncStorage.setItem(RKEY, JSON.stringify(n)).catch(() => {}); };

  // Yeni genel bölgeye girince bir kez sorar; sürüş sırasında dikkat dağıtmamak için sürüş bitince gösterir.
  checkRef.current = async (lat, lon) => {
    const p = { latitude: lat, longitude: lon };
    if (lastGeo.current && hav(lastGeo.current, p) < 3) return;
    lastGeo.current = p;
    try {
      const [a] = await Location.reverseGeocodeAsync(p);
      const name = a && (a.subregion || a.city || a.region);
      if (!name) return;
      const key = [a.isoCountryCode, a.region, name].join('|');
      const known = regionsRef.current[key];
      setCur({ key, name, photo: known?.photo });
      if (!known?.seen) {
        saveRegions({ ...regionsRef.current, [key]: { ...known, name, seen: true } });
        if (onRef.current) pending.current = { key, name }; else setAsk({ key, name });
      }
    } catch {}
  };

  const pickPhoto = async (key) => {
    setAsk(null);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, allowsMultipleSelection: true, selectionLimit: 10 });
      if (res.canceled) return;
      const added = [];
      for (const a of res.assets) {
        const to = FileSystem.documentDirectory + `reg_${Date.now()}_${added.length}.jpg`;
        await FileSystem.copyAsync({ from: a.uri, to });
        added.push(to);
      }
      const old = regionsRef.current[key] || {};
      const photos = [...(old.photos || (old.photo ? [old.photo] : [])), ...added];
      saveRegions({ ...regionsRef.current, [key]: { ...old, photos, photo: photos[0] } });
      setCur((c) => (c && c.key === key ? { ...c, photo: photos[0] } : c));
    } catch { AlertX.alert('Fotoğraf eklenemedi', 'Galeri iznini kontrol et.'); }
  };
  const delPhoto = (key, uri) => {
    const old = regionsRef.current[key], photos = (old.photos || []).filter((p) => p !== uri);
    saveRegions({ ...regionsRef.current, [key]: { ...old, photos, photo: photos[0] } });
    setCur((c) => (c && c.key === key ? { ...c, photo: photos[0] } : c));
  };

  const start = async () => {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return AlertX.alert('Konum izni gerekli', 'Sürüşü takip edebilmek için ayarlardan konum iznini aç.');
    await Location.requestBackgroundPermissionsAsync().catch(() => {});
    R = fresh();
    setLive({ speed: 0, dist: 0, max: 0, g: 0, secs: 0 });
    setRoute([]);
    const opts = { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 };
    try {
      await Location.startLocationUpdatesAsync(TASK, { ...opts, showsBackgroundLocationIndicator: true, foregroundService: { notificationTitle: 'ApexDrive', notificationBody: 'Sürüşün kaydediliyor' } });
    } catch {
      // Arka plan desteklenmiyorsa (ör. Expo Go) ön plan takibine düş
      sub.current = await Location.watchPositionAsync(opts, processLoc);
    }
    onRef.current = true; setOn(true);
  };

  const stop = async () => {
    try { if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK); } catch {}
    sub.current?.remove(); sub.current = null;
    onRef.current = false; setOn(false);
    if (pending.current) { setAsk(pending.current); pending.current = null; }
    finishCurve(R);
    const d = R, duration = (Date.now() - d.t0) / 1000;
    if (d.dist < 0.05) return AlertX.alert('Sürüş çok kısa', 'Kaydedilecek kadar mesafe alınmadı.');
    const mov = d.movingMs / 3600000;
    const t = { id: String(d.t0), start: d.t0, duration, dist: d.dist, max: d.max, avg: mov > 0 ? Math.min(d.dist / mov, d.max) : 0, acc: d.acc, brake: d.brake, corner: d.corner, stops: d.stops, maxG: d.maxG, route: d.route, left: d.left, right: d.right, turnsV: 2, maxDec: d.maxDec, maxAcc: d.maxAcc, still: Math.max(0, duration - d.movingMs / 1000) };
    const n = [t, ...trips];
    setTrips(n); AsyncStorage.setItem(KEY, JSON.stringify(n)).catch(() => {});
    setTab('profile');
    setShareTrip(t);
  };

  useEffect(() => { if (profile && trips.length) Promise.resolve(ensureProfile(profile)).then(() => syncProfile(profile, trips)); }, [profile, trips.length]);
  const saveProfile = (p) => { setProfile(p); AsyncStorage.setItem(PKEY, JSON.stringify(p)).catch(() => {}); };
  const pickAvatar = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.3, base64: true, allowsEditing: true, aspect: [1, 1] });
      if (!res.canceled) saveProfile({ ...profile, avatar: `data:image/jpeg;base64,${res.assets[0].base64}` });
    } catch {}
  };
  useEffect(() => { AsyncStorage.getItem(CKEY).then((v) => v && setCellStore((p) => [...new Set([...JSON.parse(v), ...p])])).catch(() => {}); }, []);
  useEffect(() => {
    const add = cellsOf(trips.map((t) => t.route || []));
    if (!add.length) return;
    setCellStore((p) => { const n = [...new Set([...p, ...add])]; if (n.length === p.length) return p; AsyncStorage.setItem(CKEY, JSON.stringify(n)).catch(() => {}); return n; });
  }, [trips]);
  useEffect(() => {
    if (!pReady) return;
    const lim = Date.now() - prefs.keepDays * 864e5;
    const need = trips.some((t) => (t.route && t.route.length && t.start < lim) || (t.route && t.route.length > 8 && t.turnsV !== 2) || t.still == null);
    if (need) {
      const n = trips.map((t) => {
        let x = t;
        if (x.route && x.route.length > 8 && x.turnsV !== 2) { const r = turnsFromRoute(x.route); x = { ...x, left: r.left, right: r.right, turnsV: 2 }; }
        if (x.still == null) x = { ...x, still: x.avg > 0 ? Math.max(0, x.duration - (x.dist / x.avg) * 3600) : 0 };
        return x.start < lim && x.route && x.route.length ? { ...x, route: [], pruned: true } : x;
      });
      setTrips(n); AsyncStorage.setItem(KEY, JSON.stringify(n)).catch(() => {});
    }
  }, [trips, prefs.keepDays, pReady]);
  useEffect(() => {
    AsyncStorage.getItem(SKEY).then((v) => { pLoaded.current = true; if (v) setPrefs((p) => ({ ...p, ...JSON.parse(v) })); setPReady(true); }).catch(() => { pLoaded.current = true; setPReady(true); });
  }, []);
  useEffect(() => { if (pLoaded.current) AsyncStorage.setItem(SKEY, JSON.stringify(prefs)).catch(() => {}); }, [prefs]);
  useEffect(() => {
    if (!online || !profile) return;
    if (!prefs.visible) { api(`presence?username=eq.${profile.username}`, { method: 'DELETE' }).catch(() => {}); return; }
    const push = async () => {
      try {
        const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        await api('presence?on_conflict=username', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ username: profile.username, lat: +p.coords.latitude.toFixed(2), lon: +p.coords.longitude.toFixed(2), car: profile.car ? `${profile.car.brand} ${profile.car.model}` : '', updated_at: new Date().toISOString() }) });
      } catch {}
    };
    push(); const id = setInterval(push, 120000); return () => clearInterval(id);
  }, [prefs.visible, profile?.username]);
  const cells = useMemo(() => [...new Set([...cellStore, ...cellsOf([route])])], [cellStore, route]);
  const addFriend = (u) => { const n = [...new Set([...friends, u])]; setFriends(n); AsyncStorage.setItem(FKEY, JSON.stringify(n)).catch(() => {}); };
  useEffect(() => {
    AsyncStorage.getItem(VKEY).then((v) => { vLoaded.current = true; if (v) { const j = JSON.parse(v); setVdocs(j.docs || {}); if (j.rem) setRem(j.rem); } }).catch(() => { vLoaded.current = true; });
  }, []);
  useEffect(() => {
    if (!vLoaded.current) return;
    AsyncStorage.setItem(VKEY, JSON.stringify({ docs: vdocs, rem })).catch(() => {});
    const id = setTimeout(() => scheduleReminders(vdocs, rem), 800);
    return () => clearTimeout(id);
  }, [vdocs, rem]);
  useEffect(() => { if (pReady) scheduleDaily(prefs, trips); }, [pReady, prefs.daily, trips.length]);
  useEffect(() => {
    if (!pReady) return;
    notifyUpdate();
    BackgroundTask.registerTaskAsync(UPD_TASK, { minimumInterval: 360 }).catch(() => {});
  }, [pReady]);
  useEffect(() => {
    const go = async (r) => {
      if (!r) return;
      const id = r.notification.request.identifier + ':' + r.notification.date;
      if ((await AsyncStorage.getItem('@apexdrive_resp')) === id) return;
      await AsyncStorage.setItem('@apexdrive_resp', id);
      const to = r.notification.request.content.data && r.notification.request.content.data.to;
      if (to === 'update') { setAutoUpd(true); setSettingsOpen(true); } else if (to === 'drive') setTab('drive');
    };
    Notifications.getLastNotificationResponseAsync().then(go).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((r) => { go(r).catch(() => {}); });
    return () => sub.remove();
  }, []);
  const updateTrip = (id, patch) => setTrips((p) => { const n = p.map((t) => (t.id === id ? { ...t, ...patch } : t)); AsyncStorage.setItem(KEY, JSON.stringify(n)).catch(() => {}); return n; });
  const del = (id) => { const n = trips.filter((t) => t.id !== id); setTrips(n); AsyncStorage.setItem(KEY, JSON.stringify(n)).catch(() => {}); };

  ME.car = profile && profile.car ? `${profile.car.brand} ${profile.car.model}` : '';
  if (profile === undefined) return <View style={s.root} />;
  if (profile === null) return <SafeAreaProvider><SafeAreaView style={s.root}><StatusBar style={C === LIGHT ? 'dark' : 'light'} /><Welcome onDone={saveProfile} /></SafeAreaView></SafeAreaProvider>;
  if (!profile.car) return <SafeAreaProvider><SafeAreaView style={s.root}><StatusBar style={C === LIGHT ? 'dark' : 'light'} /><Welcome existing={profile} onDone={saveProfile} /></SafeAreaView></SafeAreaProvider>;
  const TABS = [['drive', 'speedometer', 'Sürüş'], ['map', 'map', 'Harita'], ['board', 'trophy', 'Sıralama'], ['vehicle', 'car-sport', 'Araç'], ['profile', 'person', 'Profil']];
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root}>
        <StatusBar style={C === LIGHT ? 'dark' : 'light'} />
        <View style={s.hdr}>
          <TouchableOpacity onPress={() => setMenu(true)} style={{ padding: 6 }}><Ionicons name="menu" size={28} color={C.text} /></TouchableOpacity>
          <Text style={s.hdrT}>ApexDrive</Text>
        </View>
        <View style={{ flex: 1 }}>
          {tab === 'drive' && <Drive on={on} live={live} onStart={start} onStop={stop} />}
          {tab === 'map' && <MapTab route={route} cells={cells} on={on} region={cur} regions={regions} name={profile.username} profile={profile} pickPhoto={pickPhoto} delPhoto={delPhoto} onPan={(la, lo) => checkRef.current(la, lo)} />}
          {tab === 'board' && <Board me={profile} friends={friends} addFriend={addFriend} />}
          {tab === 'vehicle' && <VehicleTab me={profile} docs={vdocs} setDocs={setVdocs} rem={rem} setRem={setRem} />}
          {tab === 'profile' && <Profile me={profile} trips={trips} terr={cellStore.length} onSettings={() => setSettingsOpen(true)} onUpdate={updateTrip} onAvatar={pickAvatar} onDelete={del} />}
        </View>
        <View style={s.navWrap} pointerEvents="box-none">
          <View style={s.pill}>
            {TABS.map(([k, ic, l]) => {
              const a = tab === k;
              return (
                <TouchableOpacity key={k} onPress={() => setTab(k)} style={[s.navItem, a && s.navActive]}>
                  <Ionicons name={a ? ic : ic + '-outline'} size={22} color={a ? C.text : C.dim} />
                  {a && <Text style={s.navText} numberOfLines={1} adjustsFontSizeToFit>{l}</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity style={s.fab} onPress={on ? stop : start}>
            <Ionicons name={on ? 'stop' : 'play'} size={26} color={on ? '#FF6B6B' : C.accent} />
          </TouchableOpacity>
        </View>
        <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
          <View style={s.dBg}>
            <View style={s.dPanel}>
              <Text style={[s.title, { marginBottom: 24 }]}>Menü</Text>
              {[['clubs', 'people', 'Kulüpler']].map(([k, ic, l]) => (
                <TouchableOpacity key={k} style={s.dItem} onPress={() => { setMenu(false); setScreen(k); }}><Ionicons name={ic} size={24} color={C.accent} /><Text style={s.itemTitle}>{l}</Text></TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setMenu(false)} />
          </View>
        </Modal>
        {screen === 'clubs' && <ClubsScreen me={profile} onClose={() => setScreen(null)} />}
        {screen === 'mod' && <ModStudio me={profile} onClose={() => setScreen(null)} />}
        {shareTrip && <ShareSheet t={shareTrip} onClose={() => setShareTrip(null)} />}
        {settingsOpen && <SettingsModal prefs={prefs} setPrefs={setPrefs} autoCheck={autoUpd} onClose={() => { setSettingsOpen(false); setAutoUpd(false); }} onOpenMod={() => { setSettingsOpen(false); setAutoUpd(false); setScreen('mod'); }} />}
        <DialogHost dlg={dlg} onClose={() => setDlg(null)} />
        <Modal visible={!!ask} transparent animationType="fade" onRequestClose={() => setAsk(null)}>
          <View style={s.modalBg}>
            <View style={s.modal}>
              <Text style={s.h1}>{ask?.name}</Text>
              <Text style={[s.itemSub, { marginBottom: 18 }]}>Yeni bir bölgeye girdin. İstersen bu bölge için bir fotoğraf seçebilirsin. Zorunlu değil.</Text>
              <TouchableOpacity style={s.btn} onPress={() => pickPhoto(ask.key)}><Text style={s.btnText}>Fotoğraf ekle</Text></TouchableOpacity>
              <TouchableOpacity style={[s.btn, { backgroundColor: C.line, marginTop: 10 }]} onPress={() => setAsk(null)}><Text style={[s.btnText, { color: C.text }]}>Şimdi değil</Text></TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

export default function App() {
  const [intro, setIntro] = useState(true);
  return (
    <View style={{ flex: 1, backgroundColor: '#0B2B4A' }}>
      <AppInner />
      {intro && <Intro onDone={() => setIntro(false)} />}
    </View>
  );
}

const mk = () => StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  brand: { color: C.text, fontSize: 20, fontWeight: '800', letterSpacing: 0.5, paddingHorizontal: 20, paddingTop: 8 },
  brand2: { color: C.accent, fontSize: 16, fontWeight: '800', marginBottom: 6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  speed: { color: C.text, fontSize: 112, fontWeight: '800', fontVariant: ['tabular-nums'] },
  speedUnit: { color: C.dim, fontSize: 18, marginTop: -8 },
  row: { flexDirection: 'row', width: '100%', gap: 12, marginBottom: 12 },
  stat: { flex: 1, backgroundColor: C.card, borderRadius: 24, padding: 14 },
  statLabel: { color: C.dim, fontSize: 13 },
  statValue: { color: C.text, fontSize: 24, fontWeight: '700', marginTop: 4 },
  unit: { color: C.dim, fontSize: 13, fontWeight: '400' },
  btn: { backgroundColor: C.accent, borderRadius: 28, paddingVertical: 16, width: '100%', alignItems: 'center', marginTop: 16 },
  btnText: { color: '#06101F', fontSize: 17, fontWeight: '800' },
  hint: { color: C.dim, fontSize: 13, textAlign: 'center', marginTop: 14 },
  h1: { color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 12 },
  item: { backgroundColor: C.card, borderRadius: 24, padding: 16, marginBottom: 10 },
  itemTitle: { color: C.text, fontSize: 15, fontWeight: '600' },
  itemSub: { color: C.dim, fontSize: 13, marginTop: 4 },
  region: { width: 120, marginRight: 12 },
  regionImg: { width: 120, height: 80, borderRadius: 12, marginBottom: 6 },
  overlay: { flex: 1, backgroundColor: 'rgba(5,9,18,0.7)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: C.card, borderRadius: 20, padding: 22, width: '100%' },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabText: { color: C.dim, fontSize: 15 },
  map: { flex: 1 },
  chip: { position: 'absolute', bottom: 100, left: 12, right: 12, backgroundColor: C.card, borderRadius: 24, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  thumb: { width: 44, height: 44, borderRadius: 10, backgroundColor: C.line },
  shot: { backgroundColor: '#12203A', borderRadius: 20, padding: 20, marginTop: 8 },
  shotBrand: { color: C.accent, fontWeight: '800', fontSize: 16 },
  shotBig: { color: C.text, fontSize: 54, fontWeight: '800', marginTop: 8 },
  modalBg: { flex: 1, backgroundColor: '#000A', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: C.card, borderRadius: 20, padding: 22 },
  title: { color: C.text, fontSize: 32, fontWeight: '800', fontStyle: 'italic', marginBottom: 16 },
  sec: { color: C.text, fontSize: 22, fontWeight: '700', marginTop: 22, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 4 },
  card: { flexBasis: '47%', flexGrow: 1, backgroundColor: C.card, borderRadius: 28, padding: 18 },
  cLabel: { color: C.dim, fontSize: 14, marginTop: 14 },
  cValue: { color: C.text, fontSize: 30, fontWeight: '700', marginTop: 4 },
  cUnit: { color: C.dim, fontSize: 15, fontWeight: '400' },
  speedBox: { alignItems: 'center', marginBottom: 20 },
  rank: { color: C.accent, fontSize: 20, fontWeight: '800', width: 38 },
  name: { color: C.text, fontSize: 24, fontWeight: '800', fontStyle: 'italic' },
  avatar: { width: 76, height: 76, borderRadius: 38, backgroundColor: C.card, borderWidth: 2, borderColor: C.accent },
  logo: { width: 120, height: 120, borderRadius: 28, alignSelf: 'center', marginBottom: 24 },
  input: { backgroundColor: C.card, color: C.text, borderRadius: 24, padding: 16, fontSize: 17, marginTop: 16 },
  bar: { flexDirection: 'row', height: 44, borderRadius: 14, overflow: 'hidden', marginTop: 14 },
  barText: { color: '#fff', fontWeight: '700' },
  navWrap: { position: 'absolute', left: 16, right: 16, bottom: 24, flexDirection: 'row', alignItems: 'center', gap: 10 },
  pill: { flex: 1, flexDirection: 'row', backgroundColor: C.card, borderRadius: 40, padding: 6, justifyContent: 'space-between' },
  navItem: { flex: 1, height: 52, borderRadius: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  navActive: { backgroundColor: C.sel, flex: 2.4 },
  navText: { color: C.text, fontSize: 15, fontWeight: '600' },
  fab: { width: 58, height: 58, borderRadius: 29, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  seg: { position: 'absolute', top: 12, alignSelf: 'center', flexDirection: 'row', backgroundColor: C.card, borderRadius: 24, padding: 4 },
  segBtn: { paddingVertical: 8, paddingHorizontal: 9, borderRadius: 20 },
  segActive: { backgroundColor: C.sel },
  segText: { color: C.dim, fontWeight: '600', fontSize: 12 },
  terr: { position: 'absolute', top: 64, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#1C1C21EE', borderRadius: 32, paddingVertical: 8, paddingHorizontal: 14 },
  tav: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#5A2D25', alignItems: 'center', justifyContent: 'center' },
  tavT: { color: C.text, fontWeight: '800' },
  tname: { color: C.text, fontSize: 18, fontWeight: '800', letterSpacing: 1 },
  tkm: { color: C.text, fontSize: 16, fontWeight: '700' },
  pAv: { width: 54, height: 54, borderRadius: 27, backgroundColor: C.card, borderWidth: 2, borderColor: C.line, alignItems: 'center', justifyContent: 'center', marginVertical: 6 },
  pLetter: { color: C.accent, fontSize: 20, fontWeight: '800' },
  pBlock: { width: '92%', backgroundColor: C.card, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderWidth: 1, borderBottomWidth: 0, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  fpill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.card, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 },
  gph: { width: '31%', aspectRatio: 1 },
  shL: { color: '#FFFFFFCC', fontSize: 13 },
  shV: { color: '#fff', fontSize: 34, fontWeight: '800' },
  shBrand: { color: '#fff', fontSize: 22, fontWeight: '800', fontStyle: 'italic' },
  dot: { width: 44, height: 44, borderRadius: 22, borderWidth: 2 },
  satBtn: { position: 'absolute', right: 16, bottom: 192, width: 48, height: 48, borderRadius: 24, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  hdr: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 4 },
  hdrT: { color: C.text, fontSize: 18, fontWeight: '800', fontStyle: 'italic', marginLeft: 6 },
  dBg: { flex: 1, flexDirection: 'row', backgroundColor: '#0009' },
  dPanel: { width: 280, backgroundColor: C.bg, padding: 20, paddingTop: 56 },
  dItem: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 16 },
  rbar: { height: 6, borderRadius: 3, backgroundColor: C.line, marginTop: 10, overflow: 'hidden' },
  rfill: { height: 6, backgroundColor: C.accent },
  sthumb: { width: 110, height: 140, borderRadius: 16, marginRight: 10, backgroundColor: C.line },
  storyBtn: { position: 'absolute', left: 16, bottom: 176, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.accent, borderRadius: 26, paddingVertical: 12, paddingHorizontal: 16 },
  dlgBg: { flex: 1, backgroundColor: '#000B', alignItems: 'center', justifyContent: 'center', padding: 28 },
  dlg: { width: '100%', maxWidth: 340, backgroundColor: C.card, borderRadius: 28, padding: 22, borderWidth: 1, borderColor: C.line },
  dlgT: { color: C.text, fontSize: 19, fontWeight: '800' },
  dlgM: { color: C.dim, fontSize: 15, marginTop: 8, lineHeight: 21 },
  dlgB: { flex: 1, borderRadius: 20, paddingVertical: 13, alignItems: 'center' },
  dlgBT: { fontWeight: '700', fontSize: 15 },
  pvTop: { position: 'absolute', top: 40, left: 20, right: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rcLbl: { position: 'absolute', fontSize: 12 },
  rcBox: { borderWidth: 1, borderRadius: 12, padding: 10, backgroundColor: '#0006' },
  rcBig: { fontSize: 26, fontWeight: '600' },
  rcBig2: { fontSize: 19, fontWeight: '600' },
  rcMid: { fontSize: 16 },
  rcSm: { fontSize: 12 },
  rcSign: { width: 46, height: 46, borderRadius: 23, borderWidth: 4, borderColor: '#E5483E', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000A' },
  rcSignT: { color: '#fff', fontWeight: '800', fontSize: 17 },
  rcBar: { flexDirection: 'row', height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 8 },
  rcPanel: { flexDirection: 'row', borderWidth: 1, borderRadius: 12, paddingVertical: 10, backgroundColor: '#0006' },
  rcGauge: { width: 58, height: 58, borderRadius: 29, borderWidth: 3, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0006' },
  rcPill: { borderRadius: 14, padding: 12, backgroundColor: '#0006' },
  rcTile: { borderWidth: 1.5, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: '#0006' },
  edTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 6 },
  edOk: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.accent, borderRadius: 22, paddingVertical: 9, paddingHorizontal: 16 },
  edTools: { position: 'absolute', right: 8, top: 8, gap: 10 },
  edBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#000A', alignItems: 'center', justifyContent: 'center' },
  edTxt: { fontSize: 28, fontWeight: '800', textShadowColor: '#000A', textShadowRadius: 6, textShadowOffset: { width: 0, height: 1 } },
  edPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#000B', borderRadius: 16, padding: 8 },
  edPT: { color: '#fff', fontWeight: '700', fontSize: 14 },
  edPA: { color: '#ccc', fontSize: 12 },
  edTrash: { position: 'absolute', bottom: 14, left: '50%', marginLeft: -30, width: 60, height: 60, borderRadius: 30, backgroundColor: '#000B', alignItems: 'center', justifyContent: 'center' },
  sbadge: { position: 'absolute', right: 14, bottom: 6, color: '#fff', fontWeight: '800', fontSize: 18 },
  cvTop: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  cvBar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: C.line },
  cvIn: { flex: 1, backgroundColor: C.card, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10, color: C.text, fontSize: 16, maxHeight: 110 },
  cvIc: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  bub: { maxWidth: '84%', backgroundColor: C.card, borderRadius: 20, padding: 10, marginBottom: 8, alignSelf: 'flex-start' },
  stkCell: { width: 62, height: 62, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  camBadge: { position: 'absolute', right: 0, bottom: 0, width: 30, height: 30, borderRadius: 15, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  chk: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: C.dim, alignItems: 'center', justifyContent: 'center' },
  pinBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.line },
  editBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: C.card },
  svTop: { position: 'absolute', top: 40, left: 20, right: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  svCap: { position: 'absolute', bottom: 100, left: 20, right: 20, alignItems: 'center', gap: 10 },
  svMusic: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#000A', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14, maxWidth: '100%' },
  svBtn: { position: 'absolute', bottom: 34, minWidth: 50, height: 50, borderRadius: 25, backgroundColor: '#000A', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 14 },
  stBar: { position: 'absolute', left: 16, right: 16, bottom: 100, flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 28, padding: 12 },
  stAdd: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.accent, borderRadius: 22, paddingVertical: 9, paddingHorizontal: 16 },
});
s = mk();
