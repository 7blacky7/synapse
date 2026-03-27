using GLib;
using Gtk;

namespace MyApp.Core {

  public interface ISerializable {
    public abstract string serialize();
  }

  public struct Point {
    public double x;
    public double y;
  }

  public enum Color {
    RED,
    GREEN,
    BLUE
  }

  public delegate void EventHandler(string event);

  public abstract class BaseWidget : Gtk.Widget, ISerializable {
    public const string VERSION = "1.0";

    public signal void clicked(int x, int y);
    public signal void destroyed();

    public string name { get; set; }
    public int width { get; private set; }

    private int _counter;

    public BaseWidget(string name) {
      this.name = name;
    }

    public virtual void render(Cairo.Context ctx) {
      // TODO: implement rendering pipeline
      ctx.paint();
    }

    public abstract string serialize();

    public static BaseWidget? from_json(string json) {
      return null;
    }

    private void update_internal(double dt) {
      _counter++;
    }
  }
}
