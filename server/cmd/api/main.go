package main

import (
	"context"
	"encoding/hex"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"
	"gongdan007/server/internal/app"
	"gongdan007/server/migrations"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	key, e := hex.DecodeString(os.Getenv("GONGDAN_MASTER_KEY"))
	if e != nil || len(key) != 32 {
		slog.Error("GONGDAN_MASTER_KEY must be 64 hex characters")
		os.Exit(1)
	}
	db, e := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		slog.Error("database configuration failed")
		os.Exit(1)
	}
	defer db.Close()
	if e = migrations.Run(ctx, db); e != nil {
		slog.Error("migration failed", "error", e)
		os.Exit(1)
	}
	a := app.New(db, key)
	go a.RunCloudOutbox(ctx)
	if u := os.Getenv("BOOTSTRAP_USERNAME"); u != "" {
		if e = a.Bootstrap(ctx, u, os.Getenv("BOOTSTRAP_PASSWORD")); e != nil {
			slog.Error("bootstrap failed", "error", e)
			os.Exit(1)
		}
	}
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:18080"
	}
	srv := &http.Server{Addr: addr, Handler: a.Routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		slog.Info("API ready", "address", addr)
		if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			slog.Error("server failed", "error", e)
			stop()
		}
	}()
	<-ctx.Done()
	shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shut)
}
