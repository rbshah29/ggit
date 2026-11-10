.PHONY: deb install-deb install uninstall clean

deb:
	@./packaging/build-deb.sh

install-deb: deb
	@./install.sh --deb

install:
	@./install.sh

uninstall:
	@./install.sh --uninstall

clean:
	rm -rf build dist __pycache__
