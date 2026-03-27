import Mathlib.Data.Nat.Basic
import Mathlib.Tactic.Ring

open Nat
open List

namespace Synapse.Math

/-- A 2D point in Euclidean space -/
structure Point where
  x : Float
  y : Float
  deriving Repr, BEq

structure Circle extends Point where
  radius : Float

class Metric (α : Type) where
  dist : α → α → Float

noncomputable def euclidean_dist (p q : Point) : Float :=
  Float.sqrt ((p.x - q.x)^2 + (p.y - q.y)^2)

def add (a b : Nat) : Nat := a + b

def fibonacci (n : Nat) : Nat :=
  match n with
  | 0 => 0
  | 1 => 1
  | n + 2 => fibonacci (n + 1) + fibonacci n

private def helper (xs : List Nat) : List Nat :=
  xs.filter (· > 0)

theorem add_comm : ∀ (a b : Nat), add a b = add b a := by
  intro a b
  simp [add, Nat.add_comm]

lemma add_zero_right : ∀ (n : Nat), add n 0 = n := by
  intro n
  simp [add]

inductive Tree (α : Type) where
  | leaf : Tree α
  | node : Tree α → α → Tree α → Tree α

instance : Metric Point where
  dist := euclidean_dist

abbrev Vec2 := Point

axiom function_extensionality : ∀ {α β : Type} {f g : α → β}, (∀ x, f x = g x) → f = g

-- TODO: prove associativity of add
-- FIXME: handle negative numbers

end Synapse.Math
