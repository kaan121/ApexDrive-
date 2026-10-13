import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Alert, ScrollView, Modal, Image } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

const C = { bg: '#0F1523', card: '#182138', line: '#26314F', text: '#EAF0FF', dim: '#8A97B8', accent: '#6EC1FF', warn: '#FFB454' };
const KEY = '@apexdrive_trips', RKEY = '@apexdrive_regions', TASK = 'apexdrive-bg', G = 9.81;

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
const fresh = () => ({ t0: Date.now(), last: null, dist: 0, max: 0, movingMs: 0, acc: 0, brake: 0, corner: 0, stops: 0, maxG: 0, moved: false, stopped: false, lastEv: 0, route: [] });
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
      let lat = 0;
      if (c.heading >= 0 && d.last.c.heading >= 0 && v > 3) lat = v * (angDiff(c.heading, d.last.c.heading) * Math.PI / 180) / dt;
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
  const p = { latitude: c.latitude, longitude: c.longitude };
  const lp = d.route[d.route.length - 1];
  if ((!lp || hav(lp, p) > 0.01) && d.route.length < 4000) d.route.push(p);
  d.last = { c, t, v };
  onTick && onTick();
}
TaskManager.defineTask(TASK, ({ data, error }) => { if (!error && data?.locations) data.locations.forEach(processLoc); });

// ---- Bileşenler ----
function Stat({ label, value, unit, color }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, color && { color }]}>{value}<Text style={s.unit}> {unit}</Text></Text>
    </View>
  );
}

function TripStats({ t }) {
  return (
    <View>
      <View style={s.row}><Stat label="Mesafe" value={t.dist.toFixed(1)} unit="km" /><Stat label="Süre" value={fmtTime(t.duration)} unit="" /></View>
      <View style={s.row}><Stat label="Maks. hız" value={Math.round(t.max)} unit="km/s" color={C.warn} /><Stat label="Ort. hız" value={Math.round(t.avg)} unit="km/s" /></View>
      <View style={s.row}><Stat label="Sert hızlanma" value={t.acc} unit="kez" /><Stat label="Sert fren" value={t.brake} unit="kez" /></View>
      <View style={s.row}><Stat label="Sert viraj" value={t.corner} unit="kez" /><Stat label="Duruş" value={t.stops} unit="kez" /></View>
      <View style={s.row}><Stat label="Maks. G-kuvveti" value={t.maxG.toFixed(2)} unit="g" color={C.accent} /></View>
    </View>
  );
}

function Drive({ on, live, onStart, onStop }) {
  return (
    <View style={s.center}>
      <Text style={s.speed}>{Math.round(live.speed)}</Text>
      <Text style={s.speedUnit}>km/s</Text>
      <View style={[s.row, { marginTop: 32 }]}>
        <Stat label="Mesafe" value={live.dist.toFixed(2)} unit="km" />
        <Stat label="Süre" value={fmtTime(live.secs)} unit="" />
      </View>
      <View style={s.row}>
        <Stat label="Maks. hız" value={Math.round(live.max)} unit="km/s" color={C.warn} />
        <Stat label="Maks. G" value={live.g.toFixed(2)} unit="g" color={C.accent} />
      </View>
      <TouchableOpacity style={[s.btn, on && { backgroundColor: '#FF6B6B' }]} onPress={on ? onStop : onStart}>
        <Text style={s.btnText}>{on ? 'Sürüşü bitir' : 'Sürüşü başlat'}</Text>
      </TouchableOpacity>
      <Text style={s.hint}>Sürerken telefonu kullanma. Trafik kurallarına uy.</Text>
    </View>
  );
}

// Harita: OpenStreetMap verisi (Leaflet + CARTO karanlık katman). API anahtarı gerekmez.
const leafletHtml = (interactive) => `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#m{margin:0;height:100%;background:#0F1523}.leaflet-control-attribution{font-size:9px}</style></head><body><div id="m"></div><script>
var map=L.map('m',{zoomControl:false,dragging:${interactive},touchZoom:${interactive},doubleClickZoom:${interactive},scrollWheelZoom:false,boxZoom:false,keyboard:false}).setView([39,35],5);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:19,subdomains:'abcd',attribution:'© OpenStreetMap © CARTO'}).addTo(map);
var line=L.polyline([],{color:'#6EC1FF',weight:5}).addTo(map),me=null;
map.on('dragend',function(){var c=map.getCenter();window.ReactNativeWebView.postMessage(JSON.stringify({lat:c.lat,lng:c.lng}));});
window.setRoute=function(p){line.setLatLngs(p);};
window.fit=function(){var b=line.getBounds();if(b.isValid())map.fitBounds(b,{padding:[30,30],animate:false});};
window.setMe=function(la,lo,go){var ll=[la,lo];if(!me)me=L.circleMarker(ll,{radius:8,color:'#fff',weight:3,fillColor:'#6EC1FF',fillOpacity:1}).addTo(map);else me.setLatLng(ll);if(go)map.setView(ll,Math.max(map.getZoom(),15),{animate:true});};
</script></body></html>`;

function LeafletMap({ route, me, follow, fit, interactive = true, onMove, style }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const html = useRef(leafletHtml(interactive)).current;
  const run = (js) => ref.current?.injectJavaScript(js + ';true;');
  useEffect(() => {
    if (!ready) return;
    run(`setRoute(${JSON.stringify((route || []).map((p) => [p.latitude, p.longitude]))})`);
    if (fit) run('fit()');
  }, [ready, route]);
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

function MapTab({ route, on, region, pickPhoto, onPan }) {
  const [me, setMe] = useState(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    let sub;
    Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 10 }, (l) => setMe({ latitude: l.coords.latitude, longitude: l.coords.longitude }))
      .then((x) => { sub = x; }).catch(() => {});
    return () => sub?.remove();
  }, []);
  useEffect(() => { if (me && !seen) { setSeen(true); onPan(me.latitude, me.longitude); } }, [me]);
  return (
    <View style={s.map}>
      <LeafletMap style={s.map} route={route} me={me} follow={on || !seen} onMove={onPan} />
      {region && (
        <TouchableOpacity style={s.chip} onPress={() => pickPhoto(region.key)}>
          {region.photo ? <Image source={{ uri: region.photo }} style={s.thumb} /> : <View style={s.thumb} />}
          <View style={{ flex: 1 }}>
            <Text style={s.itemTitle}>{region.name}</Text>
            <Text style={s.itemSub}>{region.photo ? 'Fotoğrafı değiştir' : 'Fotoğraf eklemek için dokun'}</Text>
          </View>
        </TouchableOpacity>
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
    <ScrollView contentContainerStyle={{ padding: 20 }}>
      <TouchableOpacity onPress={onBack}><Text style={{ color: C.accent, marginBottom: 12 }}>Geri</Text></TouchableOpacity>
      <Text style={s.h1}>{fmtDate(t.start)}</Text>
      {t.route?.length > 1 && <LeafletMap route={t.route} fit interactive={false} style={{ height: 210, borderRadius: 16, marginBottom: 14 }} />}
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

function History({ trips, onDelete }) {
  const [sel, setSel] = useState(null);
  if (sel) return <Detail t={sel} onBack={() => setSel(null)} onDelete={() => { onDelete(sel.id); setSel(null); }} />;
  return (
    <FlatList
      data={trips}
      keyExtractor={(t) => t.id}
      contentContainerStyle={{ padding: 20 }}
      ListEmptyComponent={<Text style={s.hint}>Henüz sürüş yok. İlk sürüşünü başlat, burada görünsün.</Text>}
      renderItem={({ item: t }) => (
        <TouchableOpacity style={s.item} onPress={() => setSel(t)}>
          <Text style={s.itemTitle}>{fmtDate(t.start)}</Text>
          <Text style={s.itemSub}>{t.dist.toFixed(1)} km • {fmtTime(t.duration)} • maks. {Math.round(t.max)} km/s</Text>
        </TouchableOpacity>
      )}
    />
  );
}

export default function App() {
  const [tab, setTab] = useState('drive');
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
    setTab('history');
  };

  const del = (id) => { const n = trips.filter((t) => t.id !== id); setTrips(n); AsyncStorage.setItem(KEY, JSON.stringify(n)).catch(() => {}); };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root}>
        <StatusBar style="light" />
        <Text style={s.brand}>ApexDrive</Text>
        <View style={{ flex: 1 }}>
          {tab === 'drive' && <Drive on={on} live={live} onStart={start} onStop={stop} />}
          {tab === 'map' && <MapTab route={route} on={on} region={cur} pickPhoto={pickPhoto} onPan={(la, lo) => checkRef.current(la, lo)} />}
          {tab === 'history' && <History trips={trips} onDelete={del} />}
        </View>
        <View style={s.tabs}>
          {[['drive', 'Sürüş'], ['map', 'Harita'], ['history', 'Geçmiş']].map(([k, l]) => (
            <TouchableOpacity key={k} style={s.tab} onPress={() => setTab(k)}>
              <Text style={[s.tabText, tab === k && { color: C.accent, fontWeight: '700' }]}>{l}</Text>
            </TouchableOpacity>
          ))}
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
  stat: { flex: 1, backgroundColor: C.card, borderRadius: 14, padding: 14 },
  statLabel: { color: C.dim, fontSize: 13 },
  statValue: { color: C.text, fontSize: 24, fontWeight: '700', marginTop: 4 },
  unit: { color: C.dim, fontSize: 13, fontWeight: '400' },
  btn: { backgroundColor: C.accent, borderRadius: 16, paddingVertical: 16, width: '100%', alignItems: 'center', marginTop: 16 },
  btnText: { color: '#06101F', fontSize: 17, fontWeight: '800' },
  hint: { color: C.dim, fontSize: 13, textAlign: 'center', marginTop: 14 },
  h1: { color: C.text, fontSize: 20, fontWeight: '700', marginBottom: 12 },
  item: { backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 10 },
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
  chip: { position: 'absolute', top: 12, left: 12, right: 12, backgroundColor: C.card, borderRadius: 14, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  thumb: { width: 44, height: 44, borderRadius: 10, backgroundColor: C.line },
  shot: { backgroundColor: '#12203A', borderRadius: 20, padding: 20, marginTop: 8 },
  shotBrand: { color: C.accent, fontWeight: '800', fontSize: 16 },
  shotBig: { color: C.text, fontSize: 54, fontWeight: '800', marginTop: 8 },
  modalBg: { flex: 1, backgroundColor: '#000A', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: C.card, borderRadius: 20, padding: 22 },
});
