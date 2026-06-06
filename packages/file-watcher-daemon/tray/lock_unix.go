//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// acquireSingleInstanceLock haelt einen flock auf ~/.synapse/file-watcher/tray.lock.
// Eine zweite Instanz beendet sich sofort. Der Lock wird vom OS automatisch
// freigegeben wenn der Prozess endet (auch bei Crash oder kill -9).
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
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		fmt.Fprintln(os.Stderr, "Tray laeuft bereits (tray.lock gehalten) — beende.")
		f.Close()
		os.Exit(0)
	}
	_ = f.Truncate(0)
	_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
	return f
}
