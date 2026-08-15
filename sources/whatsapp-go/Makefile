# whatsapp-go — SuperTwinV11 WhatsApp ingestion daemon
#
# Pure-Go (CGO disabled) so the binary is self-contained and cross-compilable.

BINARY := whatsapp-go
PKG    := .

# CGO_ENABLED=0: modernc.org/sqlite is pure Go, so we never need a C toolchain.
export CGO_ENABLED := 0

.PHONY: build test vet fmt clean tidy build-arm64 build-amd64

## build: compile the daemon for the host architecture -> ./whatsapp-go
build:
	go build -o $(BINARY) $(PKG)

## test: run all unit tests
test:
	go test ./...

## vet: static analysis
vet:
	go vet ./...

## fmt: gofmt all sources in place
fmt:
	gofmt -w .

## tidy: sync go.mod/go.sum
tidy:
	go mod tidy

## build-arm64: cross-compile for Apple Silicon (aarch64-apple-darwin)
##   The Tauri .app bundles this at worker/bundle/bin/whatsapp-go.
build-arm64:
	GOOS=darwin GOARCH=arm64 go build -o $(BINARY) $(PKG)

## build-amd64: cross-compile for Intel macs
build-amd64:
	GOOS=darwin GOARCH=amd64 go build -o $(BINARY) $(PKG)

## clean: remove the built binary
clean:
	rm -f $(BINARY)
