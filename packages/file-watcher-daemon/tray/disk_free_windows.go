//go:build windows

package main

import (
	"path/filepath"

	"golang.org/x/sys/windows"
)

func freeDiskBytes(path string) (uint64, error) {
	utf16Path, err := windows.UTF16PtrFromString(filepath.Clean(path))
	if err != nil {
		return 0, err
	}
	var available uint64
	if err = windows.GetDiskFreeSpaceEx(utf16Path, &available, nil, nil); err != nil {
		return 0, err
	}
	return available, nil
}
