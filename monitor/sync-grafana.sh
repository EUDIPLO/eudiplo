#!/bin/bash

# Grafana Provisioning File Sync Script
# This script helps synchronize local provisioning files with the running Grafana instance

set -e

# Paths are resolved relative to this script, so it works from any directory.
# Override GRAFANA_CONTAINER or GRAFANA_LOCAL_DIR to use a different setup.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
GRAFANA_CONTAINER="${GRAFANA_CONTAINER:-grafana}"
LOCAL_BASE="${GRAFANA_LOCAL_DIR:-$SCRIPT_DIR/grafana}"
GRAFANA_BASE="/etc/grafana"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Grafana container is running
check_grafana_running() {
    if ! docker ps --format '{{.Names}}' | grep -qx "$GRAFANA_CONTAINER"; then
        print_error "Grafana container '$GRAFANA_CONTAINER' is not running"
        exit 1
    fi
}

# Sync provisioning files
sync_provisioning() {
    print_status "Syncing provisioning files..."
    
    # Copy provisioning files
    docker cp "$LOCAL_BASE/provisioning/." "$GRAFANA_CONTAINER:$GRAFANA_BASE/provisioning/"
    
    print_status "Provisioning files synced"
}

# Sync dashboards
sync_dashboards() {
    print_status "Syncing dashboard files..."
    
    # Copy dashboard files
    docker cp "$LOCAL_BASE/dashboards/." "$GRAFANA_CONTAINER:/var/lib/grafana/dashboards/"
    
    print_status "Dashboard files synced"
}

# Sync custom configuration
sync_config() {
    print_status "Syncing custom configuration..."
    
    # Copy custom.ini
    docker cp "$LOCAL_BASE/custom.ini" "$GRAFANA_CONTAINER:$GRAFANA_BASE/grafana.ini"
    
    print_status "Configuration synced"
}

# Reload Grafana configuration
reload_grafana() {
    print_status "Reloading Grafana configuration..."
    
    # Send HUP signal to reload configuration
    docker exec "$GRAFANA_CONTAINER" kill -HUP 1
    
    print_status "Grafana configuration reloaded"
}

# Restart Grafana (alternative to reload)
restart_grafana() {
    print_status "Restarting Grafana container..."
    
    docker-compose -f "$COMPOSE_FILE" restart grafana
    
    print_status "Grafana restarted"
}

# Watch for file changes (requires fswatch)
watch_files() {
    print_status "Watching for file changes..."
    print_warning "Press Ctrl+C to stop watching"
    
    if ! command -v fswatch &> /dev/null; then
        print_error "fswatch is not installed. Install with: brew install fswatch"
        exit 1
    fi
    
    fswatch -r "$LOCAL_BASE" | while read file; do
        print_status "File changed: $file"
        sync_all
        reload_grafana
    done
}

# Sync all files
sync_all() {
    sync_provisioning
    sync_dashboards
    sync_config
}

# Show help
show_help() {
    echo "Grafana Provisioning File Sync Script"
    echo ""
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  sync       Sync all files (provisioning, dashboards, config)"
    echo "  provision  Sync only provisioning files"
    echo "  dashboard  Sync only dashboard files"
    echo "  config     Sync only configuration file"
    echo "  reload     Reload Grafana configuration"
    echo "  restart    Restart Grafana container"
    echo "  watch      Watch for file changes and auto-sync"
    echo "  help       Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 sync      # Sync all files"
    echo "  $0 watch     # Start file watcher"
    echo "  $0 reload    # Reload Grafana config"
}

# Main script logic
main() {
    case "${1:-help}" in
        sync)
            check_grafana_running
            sync_all
            reload_grafana
            ;;
        provision)
            check_grafana_running
            sync_provisioning
            reload_grafana
            ;;
        dashboard)
            check_grafana_running
            sync_dashboards
            ;;
        config)
            check_grafana_running
            sync_config
            restart_grafana
            ;;
        reload)
            check_grafana_running
            reload_grafana
            ;;
        restart)
            restart_grafana
            ;;
        watch)
            check_grafana_running
            watch_files
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            print_error "Unknown command: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
