package expo.modules.apexdrive

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ApexDriveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ApexDrive")

    // Otomatik sürüş algılamayı açar/kapatır. veh: sürüşlerin kaydedileceği araç kimliği.
    AsyncFunction("setEnabled") { on: Boolean, veh: String, promise: Promise ->
      val c = appContext.reactContext
      if (c == null) {
        promise.resolve(false)
      } else {
        Store.prefs(c).edit().putBoolean("enabled", on).putString("veh", veh).apply()
        if (on) {
          Transitions.register(c) { ok ->
            Diag.add(c, "algilama kaydi: " + (if (ok) "basarili" else "BASARISIZ (izin?)")) // TEŞHİS
            promise.resolve(ok)
          }
        } else {
          Transitions.unregister(c)
          DriveService.stop(c)
          promise.resolve(true)
        }
      }
    }

    // Bitmiş sürüşleri JSON olarak verir: [{id, veh, pts: [[zaman, enlem, boylam, hız, doğruluk, yön], ...]}]. Silmez.
    AsyncFunction("takeTrips") {
      val c = appContext.reactContext
      if (c == null) {
        "[]"
      } else {
        val active = Store.activeName(c)
        val trips = (Store.dir(c).listFiles() ?: emptyArray())
          .filter { it.name.startsWith("trip_") && it.name != active }
          .sortedBy { it.name }
          .map { f -> Store.tripJson(f) }
        if (trips.isNotEmpty()) Diag.add(c, "uygulama " + trips.size + " kayit aldi") // TEŞHİS
        "[${trips.joinToString(",")}]"
      }
    }

    // Şu an süren otomatik kaydı uygulamaya devreder: servisi durdurur, o ana kadarki noktaları verir (yoksa ""). Dosyayı ackTrips siler.
    AsyncFunction("takeActive") {
      val c = appContext.reactContext
      val name = if (c == null) "" else Store.activeName(c)
      if (c == null || name.isEmpty()) {
        ""
      } else {
        DriveService.stop(c)
        Diag.add(c, "uygulama suren kaydi devraldi") // TEŞHİS
        Store.tripJson(File(Store.dir(c), name))
      }
    }

    // Uygulama sürüş kaydediyorken true: bu sırada "araçta" olayları yeni kayıt başlatmaz
    AsyncFunction("setBusy") { on: Boolean ->
      val c = appContext.reactContext ?: return@AsyncFunction
      Store.prefs(c).edit().putBoolean("busy", on).apply()
    }

    // TEŞHİS: geçici algılama kaydını okur / satır ekler
    AsyncFunction("getLog") {
      val c = appContext.reactContext
      if (c == null) "" else Diag.read(c)
    }

    AsyncFunction("addLog") { msg: String ->
      val c = appContext.reactContext ?: return@AsyncFunction
      Diag.add(c, msg)
    }

    // Uygulama sürüşü diske yazdıktan sonra çağrılır; kayıt dosyalarını siler.
    AsyncFunction("ackTrips") { ids: List<String> ->
      val c = appContext.reactContext ?: return@AsyncFunction
      ids.forEach { File(Store.dir(c), File(it).name).delete() }
    }
  }
}
