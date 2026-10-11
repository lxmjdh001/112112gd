package app

import (
	"errors"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode/utf8"
)

type accountFingerprint struct {
	Version             int    `json:"version"`
	Seed                string `json:"seed"`
	OS                  string `json:"os"`
	UserAgent           string `json:"userAgent"`
	GPUVendor           string `json:"gpuVendor"`
	GPURenderer         string `json:"gpuRenderer"`
	ScreenWidth         int    `json:"screenWidth"`
	ScreenHeight        int    `json:"screenHeight"`
	Timezone            string `json:"timezone"`
	Language            string `json:"language"`
	HardwareConcurrency int    `json:"hardwareConcurrency"`
	DeviceMemory        int    `json:"deviceMemory"`
	WebRTC              string `json:"webrtc"`
	CanvasNoise         bool   `json:"canvasNoise"`
	AudioNoise          bool   `json:"audioNoise"`
	WebGLNoise          bool   `json:"webglNoise"`
	BlockLocalFonts     bool   `json:"blockLocalFonts"`
}

var fingerprintSeed = regexp.MustCompile(`^[0-9a-f]{32}$`)
var fingerprintUA = regexp.MustCompile(`^[\x20-\x7e]+$`)
var fingerprintChrome = regexp.MustCompile(`Chrome/[0-9]+(?:\.[0-9]+){3}`)
var fingerprintLanguage = regexp.MustCompile(`^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$`)
var fingerprintControl = regexp.MustCompile(`[\x00-\x1f\x7f]`)

func validateAccountFingerprint(p *accountFingerprint) error {
	if p == nil {
		return nil
	}
	invalid := errors.New("指纹配置无效，请检查操作系统、浏览器标识、时区和硬件参数")
	systems := map[string]string{"windows": "Windows NT", "macos": "Macintosh; Intel Mac OS X", "linux": "X11; Linux"}
	system, ok := systems[p.OS]
	if !ok || p.Version != 1 || !fingerprintSeed.MatchString(p.Seed) || len(p.UserAgent) > 512 || !fingerprintUA.MatchString(p.UserAgent) || !fingerprintChrome.MatchString(p.UserAgent) || !strings.Contains(p.UserAgent, system) {
		return invalid
	}
	for _, value := range []string{p.GPUVendor, p.GPURenderer} {
		if utf8.RuneCountInString(value) > 240 || fingerprintControl.MatchString(value) {
			return invalid
		}
	}
	if (p.GPUVendor == "") != (p.GPURenderer == "") {
		return invalid
	}
	if p.ScreenWidth < 800 || p.ScreenWidth > 7680 || p.ScreenHeight < 600 || p.ScreenHeight > 4320 || p.HardwareConcurrency < 1 || p.HardwareConcurrency > 64 {
		return invalid
	}
	if p.DeviceMemory != 1 && p.DeviceMemory != 2 && p.DeviceMemory != 4 && p.DeviceMemory != 8 {
		return invalid
	}
	if p.WebRTC != "proxy" && p.WebRTC != "disabled" {
		return invalid
	}
	if len(p.Timezone) > 80 || p.Timezone == "" || p.Timezone == "Local" || !fingerprintLanguage.MatchString(p.Language) {
		return invalid
	}
	if _, err := time.LoadLocation(p.Timezone); err != nil {
		return invalid
	}
	return nil
}
