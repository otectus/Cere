pkgname=cere
pkgver=0.1.0
pkgrel=1
pkgdesc='A native Hyprland desktop companion for Codex and Claude CLI'
arch=('x86_64' 'aarch64')
license=('custom')
depends=('qt6-base' 'qt6-declarative' 'layer-shell-qt' 'nodejs>=24' 'hyprland' 'gtk3' 'xdg-utils' 'wireplumber' 'libnotify' 'grim' 'satty' 'systemd')
makedepends=('cmake' 'ninja' 'npm')
optdepends=('codex: Codex sessions' 'claude-code: Claude sessions')
build() {
  npm ci --ignore-scripts --prefix "$startdir"
  cmake -S "$startdir" -B "$srcdir/build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr -DBUILD_TESTING=OFF
  cmake --build "$srcdir/build"
}
package() {
  DESTDIR="$pkgdir" cmake --install "$srcdir/build"
}
