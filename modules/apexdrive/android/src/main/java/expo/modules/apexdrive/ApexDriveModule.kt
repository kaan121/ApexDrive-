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
          Transitions.register(c) { promise.resolve(it) }
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
        val num = Regex("^[-0-9.,E]+$")
        val trips = (Store.dir(c).listFiles() ?: emptyArray())
          .filter { it.name.startsWith("trip_") && it.name != active }
          .sortedBy { it.name }
          .map { f ->
            // Son satır yarım kalmış olabilir (dosyanın sonu "\n" değilse), o yüzden atılır
            val lines = f.readText().split("\n").dropLast(1).filter { ln -> ln.count { ch -> ch == ',' } == 5 && num.matches(ln) }
            val veh = f.name.removeSuffix(".jsonl").split("_").getOrElse(2) { "v0" }
            "{\"id\":\"${f.name}\",\"veh\":\"$veh\",\"pts\":[${lines.joinToString(",") { ln -> "[$ln]" }}]}"
          }
        "[${trips.joinToString(",")}]"
      }
    }

    // Uygulama sürüşü diske yazdıktan sonra çağrılır; kayıt dosyalarını siler.
    AsyncFunction("ackTrips") { ids: List<String> ->
      val c = appContext.reactContext ?: return@AsyncFunction
      ids.forEach { File(Store.dir(c), File(it).name).delete() }
    }
  }
}
