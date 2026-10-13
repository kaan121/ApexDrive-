import React, { useEffect, useMemo, useRef, useState } from 'react';
import Svg, { Path } from 'react-native-svg';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Alert, ScrollView, Modal, Image, TextInput, RefreshControl } from 'react-native';
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
const fresh = () => ({ t0: Date.now(), last: null, dist: 0, max: 0, movingMs: 0, acc: 0, brake: 0, corner: 0, stops: 0, maxG: 0, moved: false, stopped: false, lastEv: 0, route: [], left: 0, right: 0, maxDec: 0, maxAcc: 0, lastTurn: 0 });
let R = fresh();
let onTick = null;

function processLoc(loc) {
  const c = loc.coords, t = loc.timestamp, d = R;
  if (c.accuracy > 30) return;
  const v = Math.max(0, c.speed ?? 0);
  if (d.last) {
    const dt = (t - d.last.t) / 1000;
    if (dt > 0 && dt < 10) {
      if (v > 0.8) d.dist += hav(d.last.c, c);
      if (v > 1) d.movingMs += dt * 1000;
      const a = (v - d.last.v) / dt;
      let lat = 0, sd = 0;
      if (c.heading >= 0 && d.last.c.heading >= 0 && v > 3) { sd = ((c.heading - d.last.c.heading + 540) % 360) - 180; lat = v * (Math.abs(sd) * Math.PI / 180) / dt; }
      d.maxAcc = Math.max(d.maxAcc, Math.min(a, 12)); d.maxDec = Math.max(d.maxDec, Math.min(-a, 12));
      if (lat > 1.5 && t - d.lastTurn > 4000) { if (sd > 0) d.right++; else d.left++; d.lastTurn = t; }
      if (t - d.lastEv > 3000) {
        if (a > 2.5) { d.acc++; d.lastEv = t; }
        else if (a < -3) { d.brake++; d.lastEv = t; }
        else if (lat > 3) { d.corner++; d.lastEv = t; }
      }
      d.maxG = Math.max(d.maxG, Math.min(Math.sqrt(a * a + lat * lat) / G, 2.5));
    }
  }
  if (v >= 2) { d.moved = true; d.stopped = false; }
  if (v < 1 && d.moved && !d.stopped) { d.stops++; d.stopped = true; }
  d.max = Math.max(d.max, v * 3.6);
  const p = { latitude: c.latitude, longitude: c.longitude, v: Math.round(v * 3.6) };
  const lp = d.route[d.route.length - 1];
  if ((!lp || hav(lp, p) > 0.01) && d.route.length < 4000) d.route.push(p);
  d.last = { c, t, v };
  onTick && onTick();
}
TaskManager.defineTask(TASK, ({ data, error }) => { if (!error && data?.locations) data.locations.forEach(processLoc); });

// ---- Yardımcılar: toplamlar ve sıralama sunucusu ----
const totals = (trips) => trips.reduce((a, t) => ({ dist: a.dist + t.dist, time: a.time + t.duration, still: a.still + (t.still || 0), n: a.n + 1, top: Math.max(a.top, t.max), left: a.left + (t.left || 0), right: a.right + (t.right || 0), brake: a.brake + t.brake, hacc: a.hacc + t.acc, dec: Math.max(a.dec, t.maxDec || 0), acc: Math.max(a.acc, t.maxAcc || 0), g: Math.max(a.g, t.maxG), stops: a.stops + t.stops }), { dist: 0, time: 0, still: 0, n: 0, top: 0, left: 0, right: 0, brake: 0, hacc: 0, dec: 0, acc: 0, g: 0, stops: 0 });
const fmtDur = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}sa ${m}dk` : `${m}dk`; };
const online = !!(SUPA_URL && SUPA_KEY);
const api = (path, opt = {}) => fetch(`${SUPA_URL}/rest/v1/${path}`, { ...opt, headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
const register = async (username, deviceId) => {
  if (!online) return 'ok';
  try {
    const r = await api('profiles', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ username, device_id: deviceId }) });
    return r.status === 409 ? 'taken' : r.ok ? 'ok' : 'err';
  } catch { return 'err'; }
};
const syncProfile = (p, tt) => online && api(`profiles?username=eq.${encodeURIComponent(p.username)}&device_id=eq.${p.deviceId}`, { method: 'PATCH', body: JSON.stringify({ total_km: tt.dist, top_speed: tt.top, trips: tt.n, avg_speed: tt.time > tt.still ? tt.dist / ((tt.time - tt.still) / 3600) : 0 }) }).catch(() => {});

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
      <Card icon="speedometer" color="#34C759" label="Ort. hız" value={Math.round(t.avg)} unit="km/s" />
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

function Welcome({ onDone }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const u = name.trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,20}$/.test(u)) return Alert.alert('Geçersiz kullanıcı adı', '3-20 karakter olmalı; harf, rakam, _ ve . kullanabilirsin.');
    setBusy(true);
    const deviceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const res = await register(u, deviceId);
    setBusy(false);
    if (res === 'taken') return Alert.alert('Bu kullanıcı adı alınmış', 'Başka bir tane dene.');
    if (res === 'err') return Alert.alert('Bağlanılamadı', 'İnternet bağlantını kontrol edip tekrar dene.');
    onDone({ username: u, deviceId });
  };
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      <Image source={require('./icon.png')} style={s.logo} />
      <Text style={s.title}>ApexDrive'a hoş geldin</Text>
      <Text style={s.itemSub}>Sıralamada görünecek kullanıcı adını seç.</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="kullanici_adi" placeholderTextColor={C.dim} autoCapitalize="none" autoCorrect={false} maxLength={20} />
      <TouchableOpacity style={s.btn} onPress={go} disabled={busy}><Text style={s.btnText}>{busy ? 'Kontrol ediliyor...' : 'Devam'}</Text></TouchableOpacity>
    </View>
  );
}

// ---- Bölge (altıgen) hesabı ----
const EMPTY = [];
const hexKey = (lat, lon) => {
  const x = 6378137 * lon * Math.PI / 180, y = 6378137 * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const q = (Math.sqrt(3) / 3 * x - y / 3) / 300, r = (2 / 3 * y) / 300;
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
  const [fr, setFr] = useState(false);
  const [name, setName] = useState('');
  const load = async () => {
    if (!online) return;
    setBusy(true);
    try { const r = await api('profiles?select=username,total_km,top_speed,avg_speed,trips&limit=500'); const j = await r.json(); setRows(Array.isArray(j) ? j : []); } catch { setRows([]); }
    setBusy(false);
  };
  useEffect(() => { load(); }, []);
  if (!online) return <View style={{ flex: 1, padding: 20 }}><Text style={s.title}>Sıralama</Text><Text style={s.itemSub}>Sıralama sunucusu henüz bağlanmadı.</Text></View>;
  const [mk, , mu] = METRICS[mi];
  const list = rows.filter((r) => !fr || r.username === me.username || friends.includes(r.username)).sort((a, b) => (b[mk] || 0) - (a[mk] || 0));
  const val = (r) => (mk === 'total_km' ? (r.total_km || 0).toFixed(1) : Math.round(r[mk] || 0));
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
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
            <TouchableOpacity style={s.fpill} onPress={() => setFr(!fr)}><Ionicons name="people" size={16} color={C.text} /><Text style={s.navText}>{fr ? 'Arkadaşlar' : 'Herkes'}</Text></TouchableOpacity>
            <TouchableOpacity style={s.fpill} onPress={() => setMi((mi + 1) % 3)}><Ionicons name="stats-chart" size={16} color={C.text} /><Text style={s.navText}>{METRICS[mi][1]}</Text></TouchableOpacity>
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
      ListEmptyComponent={list.length ? null : <Text style={s.hint}>Henüz kimse yok.</Text>}
      renderItem={({ item, index }) => (
        <View style={[s.item, { flexDirection: 'row', alignItems: 'center' }, item.username === me.username && { borderWidth: 1, borderColor: C.accent }]}>
          <Text style={s.rank}>{index + 4}</Text>
          <View style={[s.pAv, { width: 40, height: 40, borderRadius: 20, marginRight: 12 }]}><Text style={s.pLetter}>{item.username[0].toUpperCase()}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.itemTitle}>{item.username}</Text>
            <Text style={s.itemSub}>{item.trips} sürüş</Text>
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
          <Text style={s.itemSub}>Fotoğrafı değiştirmek için dokun</Text>
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
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:19,subdomains:'abcd',attribution:'© OpenStreetMap © CARTO'}).addTo(map);
var grp=L.layerGroup().addTo(map),cg=L.layerGroup().addTo(map),pts=[],me=null,S=300,R=6378137;
function col(v){return v==null?'#6EC7C7':v<50?'#4FD1C5':v<90?'#34C759':v<120?'#FF9500':'#FF453A';}
function inv(x,y){return [(2*Math.atan(Math.exp(y/R))-Math.PI/2)*180/Math.PI,x/R*180/Math.PI];}
map.on('dragend',function(){var c=map.getCenter();window.ReactNativeWebView.postMessage(JSON.stringify({lat:c.lat,lng:c.lng}));});
window.setRoute=function(p){grp.clearLayers();pts=p;if(p.length<2)return;var cur=[[p[0][0],p[0][1]]],c=col(p[1][2]);
for(var i=1;i<p.length;i++){var k=col(p[i][2]);if(k!==c){L.polyline(cur,{color:c,weight:5}).addTo(grp);cur=[cur[cur.length-1]];c=k;}cur.push([p[i][0],p[i][1]]);}
L.polyline(cur,{color:c,weight:5}).addTo(grp);};
window.setCells=function(ks){cg.clearLayers();ks.forEach(function(k){var a=k.split(':'),q=+a[0],r=+a[1],cx=S*Math.sqrt(3)*(q+r/2),cy=S*1.5*r,c=[];
for(var i=0;i<6;i++){var t=(60*i-30)*Math.PI/180;c.push(inv(cx+S*Math.cos(t),cy+S*Math.sin(t)));}
L.polygon(c,{color:'#A78BFA',weight:1,fillColor:'#8B5CF6',fillOpacity:.55}).addTo(cg);});};
window.fit=function(){if(pts.length>1)map.fitBounds(L.latLngBounds(pts.map(function(q){return [q[0],q[1]];})),{padding:[30,30],animate:false});};
window.setMe=function(la,lo,go){var ll=[la,lo];if(!me)me=L.circleMarker(ll,{radius:8,color:'#fff',weight:3,fillColor:'#6EC7C7',fillOpacity:1}).addTo(map);else me.setLatLng(ll);if(go)map.setView(ll,Math.max(map.getZoom(),15),{animate:true});};
</script></body></html>`;

function LeafletMap({ route, cells, me, follow, fit, interactive = true, onMove, style }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const html = useRef(leafletHtml(interactive)).current;
  const run = (js) => ref.current?.injectJavaScript(js + ';true;');
  useEffect(() => {
    if (!ready) return;
    run(`setRoute(${JSON.stringify((route || []).map((p) => [p.latitude, p.longitude, p.v]))})`);
    if (fit) run('fit()');
  }, [ready, route]);
  useEffect(() => { if (ready) run(`setCells(${JSON.stringify(cells || [])})`); }, [ready, cells]);
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

function MapTab({ route, cells, on, region, pickPhoto, onPan }) {
  const [me, setMe] = useState(null);
  const [seen, setSeen] = useState(false);
  const [mode, setMode] = useState('route');
  useEffect(() => {
    let sub;
    Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 10 }, (l) => setMe({ latitude: l.coords.latitude, longitude: l.coords.longitude }))
      .then((x) => { sub = x; }).catch(() => {});
    return () => sub?.remove();
  }, []);
  useEffect(() => { if (me && !seen) { setSeen(true); onPan(me.latitude, me.longitude); } }, [me]);
  return (
    <View style={s.map}>
      <LeafletMap style={s.map} route={mode === 'route' ? route : EMPTY} cells={mode === 'cells' ? cells : EMPTY} me={me} follow={on || !seen} onMove={onPan} />
      <View style={s.seg}>
        {[['route', 'Rota'], ['cells', 'Bölgelerim']].map(([k, l]) => (
          <TouchableOpacity key={k} style={[s.segBtn, mode === k && s.segActive]} onPress={() => setMode(k)}>
            <Text style={[s.segText, mode === k && { color: C.text }]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {region && (
        <TouchableOpacity style={s.chip} onPress={() => pickPhoto(region.key)}>
          {region.photo ? <Image source={{ uri: region.photo }} style={s.thumb} /> : <View style={s.thumb} />}
          <View style={{ flex: 1 }}>
            <Text style={s.itemTitle}>{region.name}</Text>
            <Text style={s.itemSub}>{region.photo ? 'Fotoğrafı değiştir' : 'Fotoğraf eklemek için dokun'}</Text>
          </View>
        </TouchableOpacity>
      )}
      {mode === 'cells' && (
        <View style={s.terr}>
          <Text style={s.cValue}>{cells.length} <Text style={s.cUnit}>bölge</Text></Text>
          <Text style={s.itemSub}>Sürdüğün her yol haritada bölge kazandırır.</Text>
        </View>
      )}
    </View>
  );
}

function Detail({ t, onBack, onDelete }) {
  const shot = useRef(null);
  const share = async () => {
    try {
      const uri = await captureRef(shot, { format: 'png', quality: 1 });
      await Sharing.shareAsync(uri, { mimeType: 'image/png' });
    } catch { Alert.alert('Paylaşılamadı', 'Görsel oluşturulamadı, tekrar dene.'); }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
      <TouchableOpacity onPress={onBack}><Text style={{ color: C.accent, marginBottom: 12 }}>Geri</Text></TouchableOpacity>
      <Text style={s.h1}>{fmtDate(t.start)}</Text>
      {t.route?.length > 1 && <LeafletMap route={t.route} fit interactive={false} style={{ height: 260, borderRadius: 26, marginBottom: 12 }} />}
      <SpeedDist route={t.route} />
      <TripStats t={t} />
      <View ref={shot} collapsable={false} style={s.shot}>
        <Text style={s.shotBrand}>ApexDrive</Text>
        <Text style={s.shotBig}>{t.dist.toFixed(1)} km</Text>
        <Text style={s.itemSub}>{fmtDate(t.start)} • {fmtTime(t.duration)}</Text>
        <View style={[s.row, { marginTop: 16, marginBottom: 0 }]}>
          <Stat label="Maks. hız" value={Math.round(t.max)} unit="km/s" color={C.warn} />
          <Stat label="Maks. G" value={t.maxG.toFixed(2)} unit="g" color={C.accent} />
        </View>
      </View>
      <TouchableOpacity style={s.btn} onPress={share}><Text style={s.btnText}>Görsel olarak paylaş</Text></TouchableOpacity>
      <TouchableOpacity style={[s.btn, { backgroundColor: C.card, marginTop: 10 }]} onPress={onDelete}>
        <Text style={[s.btnText, { color: '#FF6B6B' }]}>Sürüşü sil</Text>
      </TouchableOpacity>
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
      if (!known) {
        saveRegions({ ...regionsRef.current, [key]: { name, asked: true } });
        if (onRef.current) pending.current = { key, name }; else setAsk({ key, name });
      }
    } catch {}
  };

  const pickPhoto = async (key) => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.4, base64: true, allowsEditing: true, aspect: [1, 1] });
      if (res.canceled) return;
      const uri = `data:image/jpeg;base64,${res.assets[0].base64}`;
      const r = { ...regionsRef.current, [key]: { ...regionsRef.current[key], photo: uri } };
      saveRegions(r);
      setCur((c) => (c && c.key === key ? { ...c, photo: uri } : c));
    } catch { Alert.alert('Fotoğraf seçilemedi', 'Galeri iznini kontrol et.'); }
    setAsk(null);
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
    const t = { id: String(d.t0), start: d.t0, duration, dist: d.dist, max: d.max, avg: mov > 0 ? d.dist / mov : 0, acc: d.acc, brake: d.brake, corner: d.corner, stops: d.stops, maxG: d.maxG, route: d.route };
    const n = [t, ...trips];
    setTrips(n); AsyncStorage.setItem(KEY, JSON.stringify(n)).catch(() => {});
    setTab('profile');
  };

  useEffect(() => { if (profile && trips.length) syncProfile(profile, totals(trips)); }, [profile, trips.length]);
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
  const TABS = [['drive', 'speedometer', 'Sürüş'], ['map', 'map', 'Harita'], ['board', 'trophy', 'Sıralama'], ['profile', 'person', 'Profil']];
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root}>
        <StatusBar style="light" />
        <View style={{ flex: 1 }}>
          {tab === 'drive' && <Drive on={on} live={live} onStart={start} onStop={stop} />}
          {tab === 'map' && <MapTab route={route} cells={cells} on={on} region={cur} pickPhoto={pickPhoto} onPan={(la, lo) => checkRef.current(la, lo)} />}
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
              <TouchableOpacity style={s.btn} onPress={() => pickPhoto(ask.key)}><Text style={s.btnText}>Fotoğraf seç</Text></TouchableOpacity>
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
  chip: { position: 'absolute', top: 64, left: 12, right: 12, backgroundColor: C.card, borderRadius: 24, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
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
  segBtn: { paddingVertical: 8, paddingHorizontal: 22, borderRadius: 20 },
  segActive: { backgroundColor: '#2E4545' },
  segText: { color: C.dim, fontWeight: '600' },
  terr: { position: 'absolute', left: 16, right: 16, bottom: 100, backgroundColor: C.card, borderRadius: 24, padding: 16 },
  pAv: { width: 54, height: 54, borderRadius: 27, backgroundColor: C.card, borderWidth: 2, borderColor: C.line, alignItems: 'center', justifyContent: 'center', marginVertical: 6 },
  pLetter: { color: C.accent, fontSize: 20, fontWeight: '800' },
  pBlock: { width: '92%', backgroundColor: C.card, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderWidth: 1, borderBottomWidth: 0, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  fpill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.card, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 },
});
