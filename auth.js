import * as SecureStore from 'expo-secure-store';
import { SUPA_URL, SUPA_KEY } from './config';

// Oturum: erişim anahtarı yalnızca bellekte, yenileme anahtarı telefonun güvenli deposunda (Keystore/Keychain) tutulur.
const RT = 'apexdrive_rt';
export const sess = { token: null, exp: 0, user: null };

const post = async (path, body, headers = {}) => {
  const ac = new AbortController(), id = setTimeout(() => ac.abort(), 10000);
  try {
    return await fetch(`${SUPA_URL}/auth/v1/${path}`, { method: 'POST', signal: ac.signal, headers: { apikey: SUPA_KEY, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } finally { clearTimeout(id); }
};

async function setSession(j) {
  sess.token = j.access_token;
  sess.exp = Date.now() + Math.max(30, (j.expires_in || 3600) - 60) * 1000;
  sess.user = j.user || sess.user;
  await SecureStore.setItemAsync(RT, j.refresh_token);
}
async function clear() {
  sess.token = null; sess.exp = 0; sess.user = null;
  await SecureStore.deleteItemAsync(RT).catch(() => {});
}

let refreshing = null;
export async function getToken() {
  if (sess.token && Date.now() < sess.exp) return sess.token;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const rt = await SecureStore.getItemAsync(RT);
        if (!rt) return null;
        const r = await post('token?grant_type=refresh_token', { refresh_token: rt });
        if (r.ok) { await setSession(await r.json()); return sess.token; }
        if (r.status >= 400 && r.status < 500) await clear(); // oturum geçersiz: yeniden giriş gerekir
        return null;
      } catch { return null; } finally { refreshing = null; }
    })();
  }
  return refreshing;
}

// user | 'offline' (oturum kayıtlı ama internet yok) | null (giriş gerekli)
export async function restore() {
  const rt = await SecureStore.getItemAsync(RT).catch(() => null);
  if (!rt) return null;
  if (await getToken()) return sess.user || 'offline';
  const still = await SecureStore.getItemAsync(RT).catch(() => null);
  return still ? 'offline' : null;
}

// Sonuç: { user } ya da { error: 'bad' | 'wait' | 'confirm' | 'err' }
export async function signIn(email, password) {
  try {
    const r = await post('token?grant_type=password', { email, password });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) { await setSession(j); return { user: j.user }; }
    if (r.status === 429) return { error: 'wait' };
    if (j.error_code === 'email_not_confirmed') return { error: 'confirm' };
    return { error: r.status >= 500 ? 'err' : 'bad' };
  } catch { return { error: 'err' }; }
}
// Sonuç: { user } ya da { error: 'exists' | 'weak' | 'wait' | 'confirm' | 'err' }
// 'confirm': sunucuda "Confirm email" açık, oturum verilmedi.
export async function signUp(email, password) {
  try {
    const r = await post('signup', { email, password });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 429) return { error: 'wait' };
      if (j.error_code === 'user_already_exists') return { error: 'exists' };
      if (j.error_code === 'weak_password') return { error: 'weak' };
      return { error: r.status >= 500 ? 'err' : 'bad' };
    }
    if (!j.access_token) return { error: 'confirm' };
    await setSession(j);
    return { user: j.user };
  } catch { return { error: 'err' }; }
}

export async function signOut() {
  try { if (sess.token) await post('logout?scope=local', {}, { Authorization: `Bearer ${sess.token}` }); } catch {}
  await clear();
}
