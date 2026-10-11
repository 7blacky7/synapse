# P16-T12: Elixir ueber tree-sitter (Felder siehe pruefer_treesitter.py).
SPRACHE = {
    'name': 'elixir',
    'endungen': ['ex', 'exs'],
    'grammatik': 'elixir',
    'modus': 'sperrend',
    'probe': {
        # Pattern-Matching im Kopf, Guards, Pipes, Capture, for-Comprehension, Sigil, Keyword-do.
        'gueltig': (
            'defmodule M do\n  @moduledoc "x"\n  def f(%{a: a} = m, [h | _t]) when is_integer(a), do: {m, h}\n\n'
            '  def g(x) do\n    x\n    |> Enum.map(&(&1 * 2))\n'
            '    |> then(fn l -> for i <- l, into: %{}, do: {i, ~s(a)} end)\n  end\nend\n'
        ),
        'kaputt': 'defmodule M do\n  def f(x do\n    x\n  end\nend\n',
    },
    'messung': (
        'P16-T12: FP 0/1025 echte .ex/.exs (parser-testkorpus = Elixir-Repo). Positivkontrolle 40/41. Offline warm '
        'p50 0,3 ms, p95 3,9 ms. Gegenprobe Code.string_to_quoted (Elixir 1.18, ohne Auswertung): ebenfalls 0/1025 '
        'und 40/41 - gleichwertig, deshalb tree-sitter (kein BEAM im Container). .eex/.heex sind Vorlagen.'
    ),
}
