.PHONY: build update

build:
	uv run generate_repos_list.py

update:
	@grep -v '^\s*#' repos.txt | grep -v '^\s*$$' | while read repo; do \
		echo "Updating $$repo..."; \
		uv run git_archaeology.py --repo "$$repo" --version_source pypi; \
	done
	$(MAKE) build
