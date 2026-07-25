// ============================================================================
// REFERENZDATEI C++ — eigener Code, kein Fremdcode. PARSER-2.
//
// ZWECK: Pruefen, ob der C++-Parser steht. Alle bisherigen Zahlen stammten aus
// llama.cpp und beschrieben dessen Codestil, nicht die Guete des Parsers.
//
// ⚠️ DIE SOLL-ZAHLEN UNTEN WURDEN BEIM SCHREIBEN DIESER DATEI FESTGELEGT,
// NICHT AUS DEM PARSER ABGELESEN. Wer die Erwartung aus dem Parser holt, prueft
// nur, ob der Parser mit sich selbst uebereinstimmt.
//
// ZAEHLREGEL FUER FUNKTIONSSYMBOLE: jede Definition mit Rumpf zaehlt einmal.
// Reine Deklarationen (Semikolon statt Rumpf) zaehlen NICHT. Lambdas zaehlen
// NICHT als eigene Funktion — sie sind Ausdruecke im umgebenden Rumpf.
//
// SOLL — FUNKTIONSSYMBOLE: 24
//   F01 addiere                  freie Funktion, einzeilige Signatur
//   F02 anwenden                 Funktionszeiger-Parameter            (CPARSER-11)
//   F03 lange_signatur           Signatur ueber mehrere Zeilen
//   F04 baue_karte               Rueckgabetyp mit Template-Komma
//   F05 einzeiler                Kontrollfluss mit Rumpf auf einer Zeile
//   F06 schleifen                break und continue, switch mit case
//   F07 mehrere_pro_zeile        mehrere Anweisungen je Zeile
//   F08 verschachtelt            verschachtelte Aufrufe als Argument
//   F09 lambda_als_argument      Lambda als Aufruf-Argument           (die add_opt-Falle)
//   F10 lambda_als_variable      Lambda einer Variablen zugewiesen
//   F11 maximum                  Template-Funktion
//   F12 paar_bilden              Template mit zwei Parametern
//   F13 Behaelter::Behaelter     Konstruktor mit Initialisierungsliste
//   F14 Behaelter::~Behaelter    Destruktor
//   F15 Behaelter::hole_groesse  const-Methode
//   F16 Behaelter::operator()    operator-Ueberladung, Aufrufoperator
//   F17 Behaelter::operator==    operator-Ueberladung, Vergleich
//   F18 Behaelter::registriere   Methode mit Funktionszeiger-Parameter
//   F19 Behaelter::spaet         ausserhalb der Klasse definiert (Klasse::Methode)
//   F20 Punkt::Punkt             Konstruktor, Signatur ueber mehrere Zeilen
//   F21 Punkt::~Punkt            Destruktor mit virtual
//   F22 Werkzeug::statisch       statische Methode
//   F23 mit_kommentaren          Kommentare in allen Stellungen
//   F24 nutze_alles              ruft mehrere der obigen auf (fuer Call-Kanten)
//
// SOLL — WEITERE SYMBOLE:
//   Klassen (class):        2   Behaelter, Werkzeug
//   Structs (struct):       1   Punkt
//   Enums:                  1   Farbe
//   Namespaces:             2   referenz, intern
//   Includes (import):      4   string, vector, map, algorithm
//
// SOLL — WAS NICHT ERKANNT WERDEN DARF (Falschtreffer-Proben):
//   - Die 3 Lambdas in F09, F10 und F24 duerfen KEIN Funktionssymbol erzeugen.
//   - Die reine Deklaration von spaet() in der Klasse zaehlt nicht mit.
//   - Der Aufruf in F08 (verschachtelte Klammern) ist keine Definition.
//   - Die Tilde in der Zeichenkette in F23 ist kein Destruktor.
//
// BEWUSST OFFEN GEBLIEBENE LUECKEN (Stand 2026-07-25, Abschluss CPARSER-15):
//   F07 mehrere_pro_zeile liefert 3 statt 6. Mehrere Anweisungen auf EINER Zeile
//     werden nicht einzeln erfasst. Ein Fix war gebaut und wurde ZURUECKGEROLLT:
//     er kostete 13 Statements und klassifizierte 19 weitere falsch (darunter ein
//     if als Deklaration), fuer netto 87 gewonnene im gesamten Bestand. Im echten
//     Code betrifft es 84 Zeilen — der Aufwand lohnt das Risiko nicht.
//   F17 Behaelter::operator== liefert 0 statt 1. Beide operator-Ueberladungen
//     teilen sich den Scope-Namen "Behaelter::operator": der Rueckwaerts-Scanner
//     in findBodies liest nur Wortzeichen, die Sonderzeichen des Operators fallen
//     aus dem Namen. Die SYMBOLE beider Operatoren sind vorhanden, nur die
//     Zuordnung eines Statements geht daneben.
//   Namensraeume tragen weiterhin symbol_type "variable", weil das Schema keinen
//     eigenen Typ kennt. Immerhin stehen sie jetzt unter ihrem Namen.
//   NICHT GEPRUEFT, weil in dieser Datei nicht enthalten: Praeprozessor-Bloecke um
//     Funktionen herum, signaturerzeugende Makros, verschachtelte Klassen,
//     Template-Spezialisierung. Neue Luecken gehoeren HIER hinein, nicht in eine
//     Fremdcode-Stichprobe.
//
// SOLL — STATEMENTS: 73
//   Zaehlregel: jede Anweisung, die mit Semikolon endet, zaehlt einmal —
//   auch mehrere auf derselben Zeile. Jeder Kontrollfluss-Kopf (if, else if,
//   else, for, while, switch, case, default) zaehlt einmal. Initialisierung und
//   Inkrement IM Kopf einer for-Schleife zaehlen NICHT separat — der Kopf ist
//   ein Statement. Deklarationen von Klassenfeldern zaehlen NICHT (sie stehen
//   ausserhalb eines Rumpfes). Der Rumpf eines einer Variablen ZUGEWIESENEN
//   Lambdas zaehlt MIT — es ist ausfuehrbarer Code der umgebenden Funktion
//   (Entscheidung des Koordinators 2026-07-25, betrifft F10).
//   KORREKTUR beim Gegenlesen: der Kopf nannte zuerst 78. Das war mein eigener
//   Additionsfehler (Summe der Einzelwerte = 70) und eine inkonsistente Regel
//   fuer den for-Kopf. Korrigiert VOR der ersten Messung, damit nicht gegen
//   eine falsche Erwartung geprueft wird.
//   Aufschluesselung je Funktion steht als Kommentar am Ende jeder Funktion.
// ============================================================================

#include <string>
#include <vector>
#include <map>
#include <algorithm>

#define MAX_WERT 100

namespace referenz {
namespace intern {

// F01 — freie Funktion, einzeilige Signatur
int addiere(int a, int b) {
    return a + b;
}   // Statements: 1

// F02 — Funktionszeiger-Parameter. Vor CPARSER-11 verhinderte das das Symbol.
int anwenden(int wert, int(*fn)(int, int)) {
    int zwischen = fn(wert, 1);
    return zwischen;
}   // Statements: 2

// F03 — Signatur ueber mehrere Zeilen
int lange_signatur(
    int erster,
    int zweiter,
    const std::string & dritter
) {
    int summe = erster + zweiter;
    summe += static_cast<int>(dritter.size());
    return summe;
}   // Statements: 3

// F04 — Rueckgabetyp mit Komma im Template
std::map<std::string, int> baue_karte() {
    std::map<std::string, int> ergebnis;
    ergebnis["eins"] = 1;
    ergebnis["zwei"] = 2;
    return ergebnis;
}   // Statements: 4

// F05 — Kontrollfluss mit Rumpf auf derselben Zeile
int einzeiler(int x) {
    if (x > 0) { x += 1; }
    for (int i = 0; i < 3; i++) { x += i; }
    while (x > MAX_WERT) { x -= 10; }
    return x;
}   // Statements: 7  (3 Koepfe + 3 Rumpfanweisungen + return)

// F06 — break und continue, switch mit case
int schleifen(int n) {
    int summe = 0;
    for (int i = 0; i < n; i++) {
        if (i == 3) {
            continue;
        }
        if (i > 7) {
            break;
        }
        summe += i;
    }
    switch (n) {
        case 1:
            summe += 10;
            break;
        case 2:
            summe += 20;
            break;
        default:
            summe += 30;
            break;
    }
    return summe;
}   // Statements: 18

// F07 — mehrere Anweisungen je Zeile
int mehrere_pro_zeile() {
    int a = 1; int b = 2; int c = 3;
    a += b; b += c;
    return a + b + c;
}   // Statements: 6

// F08 — verschachtelte Aufrufe als Argument. Keine Definition, nur Aufrufe.
std::string verschachtelt(const std::string & s) {
    return s + std::to_string(std::max(addiere(1, 2), 3));
}   // Statements: 1

// F09 — Lambda als Aufruf-Argument. Genau das Muster, das in llama.cpp
// hunderte Falschtreffer erzeugte (add_opt(common_arg(..., [](){...}))).
void lambda_als_argument(std::vector<int> & werte) {
    std::sort(werte.begin(), werte.end(), [](int a, int b) {
        return a < b;
    });
}   // Statements: 1

// F10 — Lambda einer Variablen zugewiesen
void lambda_als_variable(std::vector<int> & werte) {
    auto verdopple = [](int x) {
        return x * 2;
    };
    werte.push_back(verdopple(21));
}   // Statements: 3  (die Zuweisung, der Rumpf des Lambdas, der push_back)

// F11 — Template-Funktion
template<typename T>
T maximum(T a, T b) {
    return a > b ? a : b;
}   // Statements: 1

// F12 — Template mit zwei Parametern
template<typename A, typename B>
std::pair<A, B> paar_bilden(A erst, B zweit) {
    return std::pair<A, B>(erst, zweit);
}   // Statements: 1

// ----------------------------------------------------------------------------
// Klasse mit Konstruktor, Destruktor, Methoden und Operatoren
// ----------------------------------------------------------------------------
class Behaelter {
public:
    // F13 — Konstruktor mit Initialisierungsliste
    Behaelter(int groesse, const std::string & name) : groesse_(groesse), name_(name) {
        gefuellt_ = false;
    }   // Statements: 1

    // F14 — Destruktor
    ~Behaelter() {
        gefuellt_ = false;
    }   // Statements: 1

    // F15 — const-Methode
    int hole_groesse() const {
        return groesse_;
    }   // Statements: 1

    // F16 — operator-Ueberladung, Aufrufoperator
    int operator()(int faktor) {
        return groesse_ * faktor;
    }   // Statements: 1

    // F17 — operator-Ueberladung, Vergleich
    bool operator==(const Behaelter & other) const {
        return groesse_ == other.groesse_;
    }   // Statements: 1

    // F18 — Methode mit Funktionszeiger-Parameter
    void registriere(void(*rueckruf)(int)) {
        rueckruf(groesse_);
    }   // Statements: 1

    // Reine Deklaration — zaehlt NICHT als Funktionssymbol.
    int spaet(int wert);

private:
    int groesse_;
    std::string name_;
    bool gefuellt_;
};

// F19 — ausserhalb der Klasse definiert
int Behaelter::spaet(int wert) {
    return wert + groesse_;
}   // Statements: 1

struct Punkt {
    // F20 — Konstruktor, Signatur ueber mehrere Zeilen
    Punkt(
        double x_wert,
        double y_wert
    ) : x(x_wert), y(y_wert) {
        gueltig = true;
    }   // Statements: 1

    // F21 — Destruktor mit virtual
    virtual ~Punkt() {
        gueltig = false;
    }   // Statements: 1

    double x;
    double y;
    bool gueltig;
};

class Werkzeug {
public:
    // F22 — statische Methode
    static int statisch(int a) {
        int b = a * 2;
        return b;
    }   // Statements: 2
};

enum class Farbe { Rot, Gruen, Blau };

// F23 — Kommentare in allen Stellungen, Tilde in Zeichenkette
static int mit_kommentaren(int a) {   // nachgestellter Zeilenkommentar
    /* Blockkommentar vor der Anweisung */
    int b = a;   // nachgestellt
    std::string kein_destruktor = "~Behaelter() {";   // Tilde nur als Text
    /*
       mehrzeiliger
       Blockkommentar
    */
    return b;
}   // Statements: 3

// F24 — ruft mehrere der obigen auf, erzeugt Call-Kanten
int nutze_alles() {
    Behaelter b(5, "test");
    int summe = addiere(1, 2);
    summe += b.hole_groesse();
    summe += Werkzeug::statisch(3);
    summe += maximum(4, 5);
    std::vector<int> werte;
    lambda_als_variable(werte);
    auto zusatz = [](int x) {
        return x + 1;
    };
    summe += zusatz(6);
    return summe;
}   // Statements: 11  (KORREKTUR 2026-07-25: stand zuerst auf 9. Die Deklaration
    // in Zeile 282 und der Lambda-Rumpf waren beim Schreiben nicht mitgezaehlt.
    // Aufgefallen erst, als der Parser MEHR fand als das Soll — solange die
    // Erkennung lueckenhaft war, deckte sie den Zaehlfehler zu.)

}   // namespace intern
}   // namespace referenz
