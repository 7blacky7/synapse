package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestApiContractLegacyAndUnknownFeatures(t *testing.T) {
	known := map[string]bool{"asset_sync": true, "future_feature": true}
	for _, raw := range []string{"null", "{}", "{\"contractVersion\":99,\"features\":[\"asset_sync\"]}"} {
		got, err := apiParseContract(json.RawMessage(raw), known)
		if err != nil || got != nil {
			t.Fatalf("Legacy %s: %#v, %v", raw, got, err)
		}
	}
	got, err := apiParseContract(json.RawMessage("{\"contractVersion\":1,\"features\":[\"asset_sync\",\"unknown\",\"future_feature\",\"asset_sync\"],\"capabilityRevision\":0,\"policyRevision\":3}"), known)
	if err != nil || got == nil {
		t.Fatalf("Parser: %#v, %v", got, err)
	}
	if !reflect.DeepEqual(got.Features, []string{"asset_sync", "future_feature"}) || got.PolicyRevision == nil || *got.PolicyRevision != 3 || got.CapabilityRevision == nil || *got.CapabilityRevision != 0 {
		t.Fatalf("Vertragsfelder falsch: %#v", got)
	}
	for _, raw := range []string{
		"{\"contractVersion\":1,\"features\":[3]}",
		"{\"contractVersion\":1,\"features\":null}",
		"{\"contractVersion\":1,\"policyRevision\":-1}",
		"{\"contractVersion\":1,\"capabilityRevision\":null}",
	} {
		if _, err := apiParseContract(json.RawMessage(raw), known); err == nil {
			t.Fatalf("Ungültige Felder akzeptiert: %s", raw)
		}
	}
}

func TestApiProjectsContractFieldsAreOptional(t *testing.T) {
	var old apiProjectsResponse
	if err := json.Unmarshal([]byte("{\"success\":true,\"projects\":[\"p13_a1\"],\"activeWatchers\":[\"p13_a1\"],\"localWatchers\":[],\"projectDetails\":[]}"), &old); err != nil {
		t.Fatal(err)
	}
	if old.Capabilities != nil || !old.Success || len(old.Projects) != 1 {
		t.Fatalf("Altantwort verändert: %#v", old)
	}
	var modern apiProjectsResponse
	if err := json.Unmarshal([]byte("{\"success\":true,\"projects\":[\"p13_a1\"],\"capabilities\":{\"contractVersion\":1,\"features\":[\"asset_sync\"]}}"), &modern); err != nil {
		t.Fatal(err)
	}
	c, err := apiParseContract(modern.Capabilities, map[string]bool{"asset_sync": true})
	if err != nil || c == nil || !reflect.DeepEqual(c.Features, []string{"asset_sync"}) {
		t.Fatalf("Neue Antwort nicht lesbar: %#v %v", c, err)
	}
}
