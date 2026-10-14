import React, { useEffect, useMemo, useRef, useState } from 'react';
import Svg, { Path, Circle } from 'react-native-svg';
import * as FileSystem from 'expo-file-system/legacy';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Alert, ScrollView, Modal, Image, TextInput, RefreshControl, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

const C = { bg: '#000000', card: '#1C1C21', line: '#2C2C34', text: '#FFFFFF', dim: '#9A9AA3', accent: '#6EC7C7', warn: '#FF9500' };
const FKEY = '@apexdrive_friends', PKEY = '@apexdrive_profile', KEY = '@apexdrive_trips', RKEY = '@apexdrive_regions', TASK = 'apexdrive-bg', G = 9.81;

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
const fresh = () => ({ t0: Date.now(), last: null, dist: 0, max: 0, movingMs: 0, acc: 0, brake: 0, corner: 0, stops: 0, maxG: 0, moved: false, stopped: false, lastEv: 0, route: [], left: 0, right: 0, maxDec: 0, maxAcc: 0, lastTurn: 0, turn: 0, latS: 0, aS: 0, stillSince: 0 });
let R = fresh();
let onTick = null;

function processLoc(loc) {
  const c = loc.coords, t = loc.timestamp, d = R;
  if (c.accuracy > 30) return;
  const dt = d.last ? (t - d.last.t) / 1000 : 0;
  // Hız: GPS'in Doppler hızı; yoksa koordinat farkından (makul sınırda)
  const v = c.speed != null && c.speed >= 0 ? c.speed : dt > 0 ? Math.min((hav(d.last.c, c) * 1000) / dt, 80) : 0;
  if (d.last && dt >= 0.5 && dt < 10) {
    // Mesafe hızdan hesaplanır: duran araçta GPS sapması mesafe sayılmaz
    if (v > 1) { d.dist += (((v + d.last.v) / 2) * dt) / 1000; d.movingMs += dt * 1000; }
    const a = Math.max(-12, Math.min(12, (v - d.last.v) / dt));
    let lat = 0, sd = 0;
    if (c.heading >= 0 && d.last.c.heading >= 0 && v > 2.5) { sd = ((c.heading - d.last.c.heading + 540) % 360) - 180; lat = v * (Math.abs(sd) * Math.PI / 180) / dt; }
    d.latS = d.latS * 0.6 + lat * 0.4; d.aS = d.aS * 0.5 + a * 0.5;
    d.maxAcc = Math.max(d.maxAcc, Math.min(a, 8)); d.maxDec = Math.max(d.maxDec, Math.min(-a, 8));
    // Dönüş: yön değişimi hızlı birikirse (yaklaşık 55°+) bir dönüş sayılır; yumuşak virajlar ve GPS titremesi sayılmaz
    d.turn = d.turn * 0.85 + sd;
    if (Math.abs(d.turn) >= 55 && t - d.lastTurn > 3000) { if (d.turn > 0) d.right++; else d.left++; d.turn = 0; d.lastTurn = t; }
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
  const p = { latitude: c.latitude, longitude: c.longitude, v: Math.round(v * 3.6) };
  const lp = d.route[d.route.length - 1];
  if ((!lp || (v > 1 && hav(lp, p) > 0.01)) && d.route.length < 4000) d.route.push(p);
  d.last = { c, t, v };
  onTick && onTick();
}
TaskManager.defineTask(TASK, ({ data, error }) => { if (!error && data?.locations) data.locations.forEach(processLoc); });

// ---- Yardımcılar: toplamlar ve sıralama sunucusu ----
const totals = (trips) => trips.reduce((a, t) => ({ dist: a.dist + t.dist, time: a.time + t.duration, still: a.still + (t.still || 0), n: a.n + 1, top: Math.max(a.top, t.max), left: a.left + (t.left || 0), right: a.right + (t.right || 0), brake: a.brake + t.brake, hacc: a.hacc + t.acc, dec: Math.max(a.dec, t.maxDec || 0), acc: Math.max(a.acc, t.maxAcc || 0), g: Math.max(a.g, t.maxG), stops: a.stops + t.stops }), { dist: 0, time: 0, still: 0, n: 0, top: 0, left: 0, right: 0, brake: 0, hacc: 0, dec: 0, acc: 0, g: 0, stops: 0 });
const fmtDur = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}sa ${m}dk` : `${m}dk`; };
const online = !!(SUPA_URL && SUPA_KEY);
const api = (path, opt = {}) => fetch(`${SUPA_URL}/rest/v1/${path}`, { ...opt, headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
const register = async (username, deviceId, car) => {
  if (!online) return 'ok';
  try {
    const r = await api('profiles', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ username, device_id: deviceId, car_brand: car.brand, car_model: car.model, car_year: car.year }) });
    return r.status === 409 ? 'taken' : r.ok ? 'ok' : 'err';
  } catch { return 'err'; }
};
const monthKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}`;
const syncProfile = (p, trips) => {
  if (!online) return;
  const tt = totals(trips), mk = monthKey(new Date()), car = p.car || {};
  const mkm = trips.filter((t) => monthKey(new Date(t.start)) === mk).reduce((a, t) => a + t.dist, 0);
  api(`profiles?username=eq.${encodeURIComponent(p.username)}&device_id=eq.${p.deviceId}`, { method: 'PATCH', body: JSON.stringify({ total_km: tt.dist, top_speed: tt.top, trips: tt.n, avg_speed: tt.time > tt.still ? tt.dist / ((tt.time - tt.still) / 3600) : 0, month_km: mkm, month_key: mk, car_brand: car.brand, car_model: car.model, car_year: car.year }) }).catch(() => {});
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
  const [name, setName] = useState('');
  const [car, setCar] = useState({ brand: '', model: '', year: '' });
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const u = existing ? existing.username : name.trim().toLowerCase();
    if (!existing && !/^[a-z0-9_.]{3,20}$/.test(u)) return Alert.alert('Geçersiz kullanıcı adı', '3-20 karakter olmalı; harf, rakam, _ ve . kullanabilirsin.');
    if (!car.brand || !car.model || !car.year) return Alert.alert('Araç bilgisi eksik', 'Marka, model ve yılı seç.');
    const c = { brand: car.brand, model: car.model, year: +car.year };
    if (existing) return onDone({ ...existing, car: c });
    setBusy(true);
    const deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const res = await register(u, deviceId, c);
    setBusy(false);
    if (res === 'taken') return Alert.alert('Bu kullanıcı adı alınmış', 'Başka bir tane dene.');
    if (res === 'err') return Alert.alert('Bağlanılamadı', 'İnternet bağlantını kontrol edip tekrar dene.');
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
      <Text style={s.title}>{existing ? 'Aracını seç' : "ApexDrive'a hoş geldin"}</Text>
      {!existing && <TextInput style={s.input} value={name} onChangeText={setName} placeholder="kullanıcı adı" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false} maxLength={20} />}
      <Field label="Marka" value={car.brand} onPress={() => setPick('brand')} />
      <Field label="Model" value={car.model} off={!car.brand} onPress={() => setPick('model')} />
      <Field label="Yıl" value={car.year} onPress={() => setPick('year')} />
      <TouchableOpacity style={s.btn} onPress={go} disabled={busy}><Text style={s.btnText}>{busy ? 'Kontrol ediliyor...' : 'Devam'}</Text></TouchableOpacity>
      {pick && (
        <Picker
          title={{ brand: 'Marka', model: 'Model', year: 'Yıl' }[pick]}
          options={pick === 'brand' ? BRANDS : pick === 'model' ? CAR_MAP[car.brand] || [] : YEARS}
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
            {[['month', 'Aylık km'], ['car', 'Aynı araç']].map(([k, l]) => (
              <TouchableOpacity key={k} style={[s.segBtn, { paddingHorizontal: 20 }, type === k && s.segActive]} onPress={() => setType(k)}><Text style={[s.segText, type === k && { color: C.text }]}>{l}</Text></TouchableOpacity>
            ))}
          </View>
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

function Profile({ me, trips, terr, onAvatar, onDelete }) {
  const [sel, setSel] = useState(null);
  if (sel) return <Detail t={sel} onBack={() => setSel(null)} onDelete={() => { onDelete(sel.id); setSel(null); }} />;
  const tt = totals(trips);
  const lp = tt.left + tt.right ? (tt.left / (tt.left + tt.right)) * 100 : 50;
  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
      <Text style={s.title}>Profil</Text>
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
var E='https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/';
L.tileLayer(E+'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:16,maxZoom:19,attribution:'Esri'}).addTo(map);
L.tileLayer(E+'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',{maxNativeZoom:16,maxZoom:19}).addTo(map);
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
window.fit=function(){if(pts.length>1)map.fitBounds(L.latLngBounds(pts.map(function(q){return [q[0],q[1]];})),{padding:[30,30],animate:false});};
window.setMe=function(la,lo,go){var ll=[la,lo];if(!me)me=L.circleMarker(ll,{radius:8,color:'#fff',weight:3,fillColor:'#6EC7C7',fillOpacity:1}).addTo(map);else me.setLatLng(ll);if(go)map.setView(ll,Math.max(map.getZoom(),15),{animate:true});};
</script></body></html>`;

function LeafletMap({ route, cells, grid, me, follow, fit, interactive = true, onMove, style }) {
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
  useEffect(() => { if (ready && me) run(`setMe(${me.latitude},${me.longitude},${!!follow})`); }, [ready, me, follow]);
  return (
    <WebView
      ref={ref}
      style={style}
      originWhitelist={['*']}
      source={{ html, baseUrl: 'https://apexdrive.app' }}
      onLoadEnd={() => setReady(true)}
      onMessage={(e) => { try { const m = JSON.parse(e.nativeEvent.data); onMove && onMove(m.lat, m.lng); } catch {} }}
      scrollEnabled={false}
      nestedScrollEnabled
      overScrollMode="never"
    />
  );
}

function PhotosView({ regions, cur, pickPhoto, delPhoto }) {
  const list = Object.entries(regions).map(([k, r]) => ({ k, name: r.name, photos: r.photos || (r.photo ? [r.photo] : []) }))
    .filter((r) => r.photos.length || r.k === cur?.key).sort((a, b) => (b.k === cur?.key) - (a.k === cur?.key));
  return (
    <ScrollView style={[StyleSheet.absoluteFill, { backgroundColor: C.bg }]} contentContainerStyle={{ padding: 20, paddingTop: 70, paddingBottom: 120 }}>
      {list.length === 0 && <Text style={s.hint}>Haritada gezindikçe bölgeler burada görünür.</Text>}
      {list.map((r) => (
        <View key={r.k} style={{ marginBottom: 22 }}>
          <Text style={s.sec}>{r.name}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {r.photos.map((u) => (
              <TouchableOpacity key={u} style={s.gph} onLongPress={() => Alert.alert('Fotoğraf silinsin mi?', '', [{ text: 'Vazgeç' }, { text: 'Sil', style: 'destructive', onPress: () => delPhoto(r.k, u) }])}>
                <Image source={{ uri: u }} style={{ width: '100%', height: '100%', borderRadius: 16 }} />
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={[s.gph, { alignItems: 'center', justifyContent: 'center', backgroundColor: C.card, borderRadius: 16 }]} onPress={() => pickPhoto(r.k)}><Ionicons name="add" size={32} color={C.accent} /></TouchableOpacity>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function MapTab({ route, cells, on, region, regions, name, pickPhoto, delPhoto, onPan }) {
  const [me, setMe] = useState(null);
  const [seen, setSeen] = useState(false);
  const [mode, setMode] = useState('cells');
  useEffect(() => {
    let sub;
    Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 10 }, (l) => setMe({ latitude: l.coords.latitude, longitude: l.coords.longitude }))
      .then((x) => { sub = x; }).catch(() => {});
    return () => sub?.remove();
  }, []);
  useEffect(() => { if (me && !seen) { setSeen(true); onPan(me.latitude, me.longitude); } }, [me]);
  return (
    <View style={s.map}>
      <LeafletMap style={s.map} route={mode === 'route' ? route : EMPTY} cells={mode === 'cells' ? cells : EMPTY} me={me} follow={on || !seen} grid={mode === 'cells'} />
      {mode === 'photos' && <PhotosView regions={regions} cur={region} pickPhoto={pickPhoto} delPhoto={delPhoto} />}
      <View style={s.seg}>
        {[['route', 'Rota'], ['cells', 'Bölgelerim'], ['photos', 'Fotoğraflarım']].map(([k, l]) => (
          <TouchableOpacity key={k} style={[s.segBtn, mode === k && s.segActive]} onPress={() => setMode(k)}>
            <Text style={[s.segText, mode === k && { color: C.text }]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {region && mode !== 'photos' && (
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

function RouteSvg({ route, w, h }) {
  if (!route || route.length < 2) return null;
  const k = Math.cos(route[0].latitude * Math.PI / 180);
  const step = Math.ceil(route.length / 300), pts = route.filter((_, i) => i % step === 0 || i === route.length - 1);
  const xs = pts.map((p) => p.longitude * k), ys = pts.map((p) => -p.latitude);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), dx = Math.max(...xs) - x0 || 1e-9, dy = Math.max(...ys) - y0 || 1e-9;
  const sc = Math.min((w - 24) / dx, (h - 24) / dy), ox = (w - dx * sc) / 2, oy = (h - dy * sc) / 2;
  const P = pts.map((_, i) => [ox + (xs[i] - x0) * sc, oy + (ys[i] - y0) * sc]);
  return (
    <Svg width={w} height={h}>
      <Path d={P.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')} stroke="#fff" strokeWidth={4} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={P[0][0]} cy={P[0][1]} r={6} fill="#FF453A" />
      <Circle cx={P[P.length - 1][0]} cy={P[P.length - 1][1]} r={6} fill="#34C759" />
    </Svg>
  );
}

const THEMES = ['#0B1F2E', '#2A1245', '#3A1010', '#10321F'];
function ShareSheet({ t, onClose }) {
  const W = Dimensions.get('window').width - 40;
  const [bg, setBg] = useState(0), [photo, setPhoto] = useState(null), [layout, setLayout] = useState(0);
  const shot = useRef(null);
  const pickBg = async () => { try { const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 }); if (!r.canceled) setPhoto(r.assets[0].uri); } catch {} };
  const share = async () => {
    try { const uri = await captureRef(shot, { format: 'png', quality: 1 }); await Sharing.shareAsync(uri, { mimeType: 'image/png' }); }
    catch { Alert.alert('Paylaşılamadı', 'Görsel oluşturulamadı, tekrar dene.'); }
  };
  const L = (k, v) => <View style={{ alignItems: 'center', marginBottom: 8 }}><Text style={s.shL}>{k}</Text><Text style={s.shV}>{v}</Text></View>;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={{ padding: 20, alignItems: 'center' }}>
          <View ref={shot} collapsable={false} style={{ width: W, height: W, borderRadius: 24, overflow: 'hidden', backgroundColor: THEMES[bg] }}>
            {photo && <Image source={{ uri: photo }} style={StyleSheet.absoluteFill} resizeMode="cover" />}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: photo ? '#0008' : 'transparent', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 26 }]}>
              <View style={{ alignItems: 'center' }}>
                {L('Mesafe', `${t.dist < 10 ? t.dist.toFixed(1) : Math.round(t.dist)} km`)}
                {layout < 2 && L('Süre', fmtDur(t.duration))}
                {layout === 1 && L('Maks. hız', `${Math.round(t.max)} km/s`)}
                {layout === 1 && L('Ort. hız', `${Math.round(Math.min(t.avg, t.max))} km/s`)}
              </View>
              <RouteSvg route={t.route} w={W - 60} h={W * (layout === 1 ? 0.3 : 0.42)} />
              <Text style={s.shBrand}>ApexDrive</Text>
            </View>
          </View>
          <Text style={[s.itemSub, { alignSelf: 'flex-start', marginTop: 18 }]}>Arka plan</Text>
          <View style={{ flexDirection: 'row', gap: 12, alignSelf: 'flex-start', marginTop: 8 }}>
            {THEMES.map((c, i) => <TouchableOpacity key={c} onPress={() => { setBg(i); setPhoto(null); }} style={[s.dot, { backgroundColor: c, borderColor: !photo && bg === i ? C.accent : C.line }]} />)}
            <TouchableOpacity onPress={pickBg} style={[s.dot, { backgroundColor: C.card, borderColor: photo ? C.accent : C.line, alignItems: 'center', justifyContent: 'center' }]}><Ionicons name="image" size={20} color={C.text} /></TouchableOpacity>
          </View>
          <Text style={[s.itemSub, { alignSelf: 'flex-start', marginTop: 16 }]}>Düzen</Text>
          <View style={{ flexDirection: 'row', gap: 10, alignSelf: 'flex-start', marginTop: 8 }}>
            {['Klasik', 'Detaylı', 'Minimal'].map((l, i) => <TouchableOpacity key={l} style={[s.fpill, layout === i && { backgroundColor: '#2E4545' }]} onPress={() => setLayout(i)}><Text style={s.navText}>{l}</Text></TouchableOpacity>)}
          </View>
          <TouchableOpacity style={[s.btn, { marginTop: 24 }]} onPress={share}><Text style={s.btnText}>Paylaş</Text></TouchableOpacity>
          <TouchableOpacity onPress={onClose}><Text style={{ color: C.accent, padding: 16 }}>Kapat</Text></TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Detail({ t, onBack, onDelete }) {
  const [sharing, setSharing] = useState(false);
  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
      <TouchableOpacity onPress={onBack}><Text style={{ color: C.accent, marginBottom: 12 }}>Geri</Text></TouchableOpacity>
      <Text style={s.h1}>{fmtDate(t.start)}</Text>
      {t.route?.length > 1 && <LeafletMap route={t.route} fit interactive={false} style={{ height: 260, borderRadius: 26, marginBottom: 12 }} />}
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

export default function App() {
  const [tab, setTab] = useState('drive');
  const [profile, setProfile] = useState(undefined);
  const [friends, setFriends] = useState([]);
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
    } catch { Alert.alert('Fotoğraf eklenemedi', 'Galeri iznini kontrol et.'); }
  };
  const delPhoto = (key, uri) => {
    const old = regionsRef.current[key], photos = (old.photos || []).filter((p) => p !== uri);
    saveRegions({ ...regionsRef.current, [key]: { ...old, photos, photo: photos[0] } });
    setCur((c) => (c && c.key === key ? { ...c, photo: photos[0] } : c));
  };

  const start = async () => {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return Alert.alert('Konum izni gerekli', 'Sürüşü takip edebilmek için ayarlardan konum iznini aç.');
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
    const d = R, duration = (Date.now() - d.t0) / 1000;
    if (d.dist < 0.05) return Alert.alert('Sürüş çok kısa', 'Kaydedilecek kadar mesafe alınmadı.');
    const mov = d.movingMs / 3600000;
    const t = { id: String(d.t0), start: d.t0, duration, dist: d.dist, max: d.max, avg: mov > 0 ? Math.min(d.dist / mov, d.max) : 0, acc: d.acc, brake: d.brake, corner: d.corner, stops: d.stops, maxG: d.maxG, route: d.route };
    const n = [t, ...trips];
    setTrips(n); AsyncStorage.setItem(KEY, JSON.stringify(n)).catch(() => {});
    setTab('profile');
  };

  useEffect(() => { if (profile && trips.length) syncProfile(profile, trips); }, [profile, trips.length]);
  const saveProfile = (p) => { setProfile(p); AsyncStorage.setItem(PKEY, JSON.stringify(p)).catch(() => {}); };
  const pickAvatar = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.3, base64: true, allowsEditing: true, aspect: [1, 1] });
      if (!res.canceled) saveProfile({ ...profile, avatar: `data:image/jpeg;base64,${res.assets[0].base64}` });
    } catch {}
  };
  const tripCells = useMemo(() => cellsOf(trips.map((t) => t.route || [])), [trips]);
  const cells = useMemo(() => [...new Set([...tripCells, ...cellsOf([route])])], [tripCells, route]);
  const addFriend = (u) => { const n = [...new Set([...friends, u])]; setFriends(n); AsyncStorage.setItem(FKEY, JSON.stringify(n)).catch(() => {}); };
  const del = (id) => { const n = trips.filter((t) => t.id !== id); setTrips(n); AsyncStorage.setItem(KEY, JSON.stringify(n)).catch(() => {}); };

  if (profile === undefined) return <View style={s.root} />;
  if (profile === null) return <SafeAreaProvider><SafeAreaView style={s.root}><StatusBar style="light" /><Welcome onDone={saveProfile} /></SafeAreaView></SafeAreaProvider>;
  if (!profile.car) return <SafeAreaProvider><SafeAreaView style={s.root}><StatusBar style="light" /><Welcome existing={profile} onDone={saveProfile} /></SafeAreaView></SafeAreaProvider>;
  const TABS = [['drive', 'speedometer', 'Sürüş'], ['map', 'map', 'Harita'], ['board', 'trophy', 'Sıralama'], ['profile', 'person', 'Profil']];
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root}>
        <StatusBar style="light" />
        <View style={{ flex: 1 }}>
          {tab === 'drive' && <Drive on={on} live={live} onStart={start} onStop={stop} />}
          {tab === 'map' && <MapTab route={route} cells={cells} on={on} region={cur} regions={regions} name={profile.username} pickPhoto={pickPhoto} delPhoto={delPhoto} onPan={(la, lo) => checkRef.current(la, lo)} />}
          {tab === 'board' && <Board me={profile} friends={friends} addFriend={addFriend} />}
          {tab === 'profile' && <Profile me={profile} trips={trips} terr={tripCells.length} onAvatar={pickAvatar} onDelete={del} />}
        </View>
        <View style={s.navWrap} pointerEvents="box-none">
          <View style={s.pill}>
            {TABS.map(([k, ic, l]) => {
              const a = tab === k;
              return (
                <TouchableOpacity key={k} onPress={() => setTab(k)} style={[s.navItem, a && s.navActive]}>
                  <Ionicons name={a ? ic : ic + '-outline'} size={22} color={a ? C.text : C.dim} />
                  {a && <Text style={s.navText}>{l}</Text>}
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity style={s.fab} onPress={on ? stop : start}>
            <Ionicons name={on ? 'stop' : 'play'} size={26} color={on ? '#FF6B6B' : C.accent} />
          </TouchableOpacity>
        </View>
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

const s = StyleSheet.create({
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
  navItem: { height: 52, minWidth: 52, paddingHorizontal: 14, borderRadius: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  navActive: { backgroundColor: '#2E4545' },
  navText: { color: C.text, fontSize: 15, fontWeight: '600' },
  fab: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  seg: { position: 'absolute', top: 12, alignSelf: 'center', flexDirection: 'row', backgroundColor: C.card, borderRadius: 24, padding: 4 },
  segBtn: { paddingVertical: 8, paddingHorizontal: 13, borderRadius: 20 },
  segActive: { backgroundColor: '#2E4545' },
  segText: { color: C.dim, fontWeight: '600' },
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
});
