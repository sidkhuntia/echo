package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// statusInterval is how often the shared poller looks at the repository.
const statusInterval = 2 * time.Second

// statusHub runs one poller for the whole process, however many tabs are open. It starts with the
// first subscriber and stops with the last, so an idle echo does no Git work.
type statusHub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
	last []byte
	stop chan struct{}
}

// subscribe returns a channel of status snapshots (JSON). It holds only the newest one: a slow
// tab skips ahead instead of queueing.
func (h *statusHub) subscribe(a *App) chan []byte {
	ch := make(chan []byte, 1)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs == nil {
		h.subs = map[chan []byte]struct{}{}
	}
	h.subs[ch] = struct{}{}
	if h.last != nil {
		ch <- h.last
	}
	if len(h.subs) == 1 {
		h.stop = make(chan struct{})
		go h.run(a, h.stop)
	}
	return ch
}

func (h *statusHub) unsubscribe(ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, ch)
	if len(h.subs) == 0 && h.stop != nil {
		close(h.stop)
		h.stop, h.last = nil, nil
	}
}

func (h *statusHub) run(a *App, stop chan struct{}) {
	ticker := time.NewTicker(statusInterval)
	defer ticker.Stop()
	for {
		data, _ := json.Marshal(a.gitStatus())
		h.mu.Lock()
		select {
		case <-stop: // the last tab left while the status was being computed
			h.mu.Unlock()
			return
		default:
		}
		if !bytes.Equal(data, h.last) {
			h.last = data
			for ch := range h.subs {
				select {
				case <-ch:
				default:
				}
				ch <- data
			}
		}
		h.mu.Unlock()
		select {
		case <-stop:
			return
		case <-a.done:
			return
		case <-ticker.C:
		}
	}
}

func (a *App) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ch := a.hub.subscribe(a)
	defer a.hub.unsubscribe(ch)
	for {
		select {
		case <-r.Context().Done():
			return
		case <-a.done:
			return
		case data := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}
