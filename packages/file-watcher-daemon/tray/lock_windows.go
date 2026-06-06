//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// acquireSingleInstanceLock haelt einen exklusiven LockFileEx auf
// %USERPROFILE%\.synapse\file-watcher\tray.lock. Eine zweite Instanz beendet
// sich sofort. Der Lock wird vom OS freigegeben wenn der Prozess endet.
func acquireSingleInstanceLock() *os.File {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	lockPath := filepath.Join(home, ".synapse", "file-watcher", "tray.lock")
	_ = os.MkdirAll(filepath.Dir(lockPath), 0o755)
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil // Lock nicht anlegbar — lieber ohne Lock starten als gar nicht
	}
	ol := new(windows.Overlapped)
	if err := windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ol); err != nil {
		fmt.Fprintln(os.Stderr, "Tray laeuft bereits (tray.lock gehalten) — beende.")
		f.Close()
		os.Exit(0)
	}
	_ = f.Truncate(0)
	_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
	return f
}
