/*
 * MODUL: JVM-Hilfsprozess im Pruef-Container (P16-T5 E3b, 11.10.2026)
 *
 * Kotlin und Java sind nur mit einer JVM sinnvoll pruefbar (ktlint je Datei: 620-790 ms Start). Deshalb laeuft EIN
 * dauerhafter JVM-Prozess, den pruefserver.py traege startet (erste Kotlin-/Java-Anfrage oder Vorwaermen), haelt und
 * nach einem Absturz neu startet. Er lebt und stirbt mit dem Container (gleicher Idle-Stop).
 *
 * NUR PARSEN, nichts kompilieren, nichts ausfuehren, kein Classpath des Nutzers:
 *   kotlin: KtPsiFactory.createFile aus kotlin-compiler-embeddable (PSI-Parser des Kotlin-Compilers), Meldung =
 *           erstes PsiErrorElement. .kts wird als Skript geparst (Dateiname entscheidet).
 *   java:   javac-API JavacTask.parse() (nur Parser, keine Attribution), Meldung = erster Diagnostic ERROR.
 *           Sprachstand = das JDK des Images (javac ohne --release = neueste Sprache). Meldungen, die nur sagen, dass
 *           eine Preview-Funktion abgeschaltet ist, sind weich (gueltiger Code einer neueren Java-Version).
 *
 * PROTOKOLL (Zeilen, UTF-8, Tab-getrennt, Texte Base64, damit Tabs/Zeilenumbrueche im Inhalt nichts stoeren):
 *   Start:  der Prozess schreibt "bereit" (Kotlin/Java selbst werden erst bei Bedarf initialisiert).
 *   rein:   <id> \t kotlin|java \t b64(pfad) \t b64(inhalt)
 *           <id> \t warm                       (beide Parser initialisieren und anwaermen)
 *   raus:   <id> \t ok \t <n> [\t zeile \t spalte \t weich(0|1) \t b64(code) \t b64(meldung)]*n
 *           <id> \t fehler \t b64(text)
 * System.out wird auf stderr umgelenkt: Ausgaben aus den Bibliotheken koennen das Protokoll nicht stoeren.
 */
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

import com.sun.source.util.JavacTask;
import org.jetbrains.kotlin.cli.FrontendConfigurationKeysKt;
import org.jetbrains.kotlin.cli.common.CLIConfigurationKeys;
import org.jetbrains.kotlin.cli.common.messages.MessageCollector;
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles;
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment;
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer;
import org.jetbrains.kotlin.compiler.plugin.CompilerPluginRegistrar;
import org.jetbrains.kotlin.com.intellij.psi.PsiErrorElement;
import org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil;
import org.jetbrains.kotlin.config.CompilerConfiguration;
import org.jetbrains.kotlin.psi.KtFile;
import org.jetbrains.kotlin.psi.KtPsiFactory;

public final class JvmPruefer {
  private static final Base64.Encoder B64 = Base64.getEncoder();
  private static final Base64.Decoder B64D = Base64.getDecoder();
  private static PrintStream aus;
  private static KtPsiFactory kotlin;
  private static JavaCompiler javac;
  private static StandardJavaFileManager javacDateien;

  private record Meldung(int zeile, int spalte, boolean weich, String code, String text) {}

  private static String b64(String s) {
    return B64.encodeToString((s == null ? "" : s).getBytes(StandardCharsets.UTF_8));
  }

  private static String aus64(String s) {
    return new String(B64D.decode(s), StandardCharsets.UTF_8);
  }

  private static synchronized KtPsiFactory kotlin() {
    if (kotlin == null) {
      CompilerConfiguration conf = new CompilerConfiguration();
      conf.put(CLIConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.Companion.getNONE());
      // Kotlin >= 2.2: ohne registrierten (leeren) Erweiterungsspeicher scheitert createForProduction.
      FrontendConfigurationKeysKt.setExtensionsStorage(conf, new CompilerPluginRegistrar.ExtensionStorage());
      KotlinCoreEnvironment env = KotlinCoreEnvironment.createForProduction(Disposer.newDisposable(), conf,
          EnvironmentConfigFiles.JVM_CONFIG_FILES);
      kotlin = new KtPsiFactory(env.getProject(), false);
    }
    return kotlin;
  }

  private static synchronized JavaCompiler javac() {
    if (javac == null) {
      javac = ToolProvider.getSystemJavaCompiler();
      javacDateien = javac.getStandardFileManager(null, Locale.ROOT, StandardCharsets.UTF_8);
    }
    return javac;
  }

  /** Dateiname fuer den Parser: nur der letzte Pfadteil; ohne passende Endung wird sie ergaenzt. */
  private static String dateiname(String pfad, String endung, String standard) {
    String name = pfad == null ? "" : pfad.substring(pfad.lastIndexOf('/') + 1).replaceAll("[^A-Za-z0-9_.$-]", "_");
    if (name.isEmpty()) name = standard;
    return name.endsWith(endung) || (endung.equals(".kt") && name.endsWith(".kts")) ? name : name + endung;
  }

  static List<Meldung> pruefeKotlin(String pfad, String text) {
    String quelle = text.replace("\r\n", "\n");
    KtFile datei = kotlin().createFile(dateiname(pfad, ".kt", "pruef.kt"), quelle);
    List<Meldung> m = new ArrayList<>();
    PsiErrorElement erster = null;
    for (PsiErrorElement e : PsiTreeUtil.collectElementsOfType(datei, PsiErrorElement.class)) {
      if (erster == null || e.getTextOffset() < erster.getTextOffset()) erster = e;
    }
    if (erster != null) {
      int off = Math.min(erster.getTextOffset(), quelle.length());
      int zeile = 1, start = 0;
      for (int i = 0; i < off; i++) if (quelle.charAt(i) == '\n') { zeile++; start = i + 1; }
      m.add(new Meldung(zeile, off - start + 1, false, "kotlin-psi", erster.getErrorDescription()));
    }
    return m;
  }

  static List<Meldung> pruefeJava(String pfad, String text) {
    String name = dateiname(pfad, ".java", "Pruef.java");
    SimpleJavaFileObject quelle = new SimpleJavaFileObject(URI.create("string:///" + name), JavaFileObject.Kind.SOURCE) {
      @Override public CharSequence getCharContent(boolean ignore) { return text; }
    };
    DiagnosticCollector<JavaFileObject> dc = new DiagnosticCollector<>();
    JavacTask t = (JavacTask) javac().getTask(null, javacDateien, dc,
        List.of("-proc:none", "-Xlint:none", "-nowarn", "-implicit:none"), null, List.of(quelle));
    try {
      t.parse();
    } catch (java.io.IOException e) {
      throw new RuntimeException(e);
    }
    List<Meldung> m = new ArrayList<>();
    for (Diagnostic<? extends JavaFileObject> d : dc.getDiagnostics()) {
      if (d.getKind() != Diagnostic.Kind.ERROR) continue;
      String code = d.getCode() == null ? "" : d.getCode();
      boolean weich = code.contains("preview");
      String text2 = d.getMessage(Locale.ROOT);
      if (weich) text2 = text2 + " (Preview-Funktion: gueltig mit --enable-preview bzw. in einer neueren Java-Version)";
      m.add(new Meldung((int) Math.max(1, d.getLineNumber()), (int) Math.max(1, d.getColumnNumber()), weich, code, text2));
      if (!weich) break;
      if (m.size() >= 5) break;
    }
    return m;
  }

  private static void warm() {
    for (int i = 0; i < 30; i++) {
      pruefeKotlin("w.kt", "package w\n\ndata class P(val x: Int)\n\nfun f(p: P) = when (p.x) { 0 -> \"null\" else -> \"$" + "{p.x + " + i + "}\" }\n");
      pruefeJava("W.java", "class W { record R(int x) {} int f(Object o) { return o instanceof R(int x) ? x + " + i + " : 0; } }\n");
    }
  }

  public static void main(String[] args) throws Exception {
    aus = new PrintStream(new FileOutputStream(FileDescriptor.out), false, StandardCharsets.UTF_8);
    System.setOut(System.err);
    if (args.length > 0 && args[0].equals("--probe")) {
      // Image-Build: beide Parser einmal laufen lassen, ein Fehler muss gemeldet werden.
      warm();
      List<Meldung> k = pruefeKotlin("p.kt", "fun a() {\n  val x = \n}\n");
      List<Meldung> j = pruefeJava("P.java", "class P {\n  void a() { int x = ; }\n}\n");
      System.err.println("probe kotlin " + k + " java " + j);
      if (k.isEmpty() || j.isEmpty()) System.exit(1);
      return;
    }
    BufferedReader ein = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    aus.print("bereit\n");
    aus.flush();
    String zeile;
    while ((zeile = ein.readLine()) != null) {
      if (zeile.isBlank()) continue;
      String[] t = zeile.split("\t", -1);
      String id = t[0];
      StringBuilder antwort = new StringBuilder(id);
      try {
        List<Meldung> m;
        if (t.length >= 2 && t[1].equals("warm")) {
          warm();
          m = List.of();
        } else if (t.length >= 4 && t[1].equals("kotlin")) {
          m = pruefeKotlin(aus64(t[2]), aus64(t[3]));
        } else if (t.length >= 4 && t[1].equals("java")) {
          m = pruefeJava(aus64(t[2]), aus64(t[3]));
        } else {
          throw new IllegalArgumentException("unbekannte Anfrage");
        }
        antwort.append("\tok\t").append(m.size());
        for (Meldung x : m) {
          antwort.append('\t').append(x.zeile()).append('\t').append(x.spalte()).append('\t').append(x.weich() ? 1 : 0)
              .append('\t').append(b64(x.code())).append('\t').append(b64(x.text()));
        }
      } catch (Throwable e) {
        antwort.setLength(0);
        antwort.append(id).append("\tfehler\t").append(b64(e.getClass().getSimpleName() + ": " + e.getMessage()));
        if (e instanceof OutOfMemoryError || e instanceof StackOverflowError) {
          System.err.println("[jvm] " + e + " - Antwort und weiter");
        }
      }
      aus.print(antwort.append('\n'));
      aus.flush();
    }
  }
}
