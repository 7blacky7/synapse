with Ada.Text_IO; use Ada.Text_IO;
with Ada.Strings.Unbounded; use Ada.Strings.Unbounded;
with GNAT.Sockets;

package body Synapse.Agent is

   Max_Retries : constant := 3;
   Default_Model : constant String := "claude-opus-4-6";

   type Status is (Active, Idle, Stopped, Error);

   type Agent_Config is record
      Model       : Unbounded_String := To_Unbounded_String(Default_Model);
      Max_Tokens  : Natural := 4096;
      Temperature : Float := 0.7;
   end record;

   type Agent is tagged record
      Name   : Unbounded_String;
      Config : Agent_Config;
      State  : Status := Idle;
   end record;

   type Agent_Access is access all Agent;

   procedure Initialize (Self : in out Agent; Name : String; Config : Agent_Config := (others => <>)) is
   begin
      Self.Name := To_Unbounded_String(Name);
      Self.Config := Config;
      Self.State := Idle;
   end Initialize;

   function Process (Self : in out Agent; Message : String) return String is
   begin
      if Message'Length = 0 then
         raise Constraint_Error with "Empty message";
      end if;
      Self.State := Active;
      -- TODO: implement actual model call
      Self.State := Idle;
      return "Response to: " & Message;
   end Process;

   function Get_Tools (Self : Agent) return String is
   begin
      return "search,read,write";
   end Get_Tools;

   function Get_Status (Self : Agent) return Status is
   begin
      return Self.State;
   end Get_Status;

   function Create_Agent (Name : String) return Agent is
      A : Agent;
   begin
      Initialize(A, Name);
      return A;
   end Create_Agent;

   generic
      type Element is private;
   package Agent_Lists is
      procedure Add (Item : Element);
   end Agent_Lists;

   -- FIXME: add proper exception handling
end Synapse.Agent;
