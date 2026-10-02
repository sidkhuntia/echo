package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// Hunk headings. Git names the section a hunk sits in (the text after its @@ line) with a rule per
// language, but only for files whose diff attribute names a driver, and most repositories never set
// one; Git then takes the nearest line above that starts with a letter, which in CSS is the
// neighbouring rule and in Markdown a random bullet. echo's own diffs map extensions to Git's
// built-in drivers, add a JavaScript/TypeScript rule Git lacks, and give data files no heading, since
// a wrong one reads worse than none. The repository's .gitattributes still wins, and so do the user's
// global attributes, which are copied in after echo's lines (later lines override earlier ones).
const diffAttributes = `*.go diff=golang
*.css diff=css
*.scss diff=css
*.less diff=css
*.html diff=html
*.htm diff=html
*.md diff=markdown
*.markdown diff=markdown
*.py diff=python
*.rs diff=rust
*.java diff=java
*.kt diff=kotlin
*.kts diff=kotlin
*.rb diff=ruby
*.php diff=php
*.c diff=cpp
*.h diff=cpp
*.cc diff=cpp
*.cpp diff=cpp
*.cxx diff=cpp
*.hpp diff=cpp
*.hh diff=cpp
*.cs diff=csharp
*.m diff=objc
*.pl diff=perl
*.pm diff=perl
*.sh diff=bash
*.bash diff=bash
*.zsh diff=bash
*.ex diff=elixir
*.exs diff=elixir
*.tex diff=tex
*.bib diff=bibtex
*.f90 diff=fortran
*.pas diff=pascal
*.scm diff=scheme
*.dts diff=dts
*.js diff=echo-js
*.mjs diff=echo-js
*.cjs diff=echo-js
*.jsx diff=echo-js
*.ts diff=echo-js
*.tsx diff=echo-js
*.mts diff=echo-js
*.json diff=echo-none
*.jsonc diff=echo-none
*.lock diff=echo-none
*.yaml diff=echo-none
*.yml diff=echo-none
*.toml diff=echo-none
*.ini diff=echo-none
*.env diff=echo-none
*.txt diff=echo-none
*.csv diff=echo-none
*.tsv diff=echo-none
*.svg diff=echo-none
*.xml diff=echo-none
*.plist diff=echo-none
*.log diff=echo-none
*.sum diff=echo-none
LICENSE* diff=echo-none
*.LICENSE diff=echo-none
`

// jsFuncname finds function declarations, functions and arrow functions bound to a name, and classes.
const jsFuncname = `^[[:blank:]]*((export[[:blank:]]+)?(default[[:blank:]]+)?(async[[:blank:]]+)?function\*?[[:blank:]]+[A-Za-z_$][A-Za-z0-9_$]*.*)$
^[[:blank:]]*((export[[:blank:]]+)?(const|let|var)[[:blank:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:blank:]]*=[[:blank:]]*(async[[:blank:]]*)?(function|\([^)]*\)[[:blank:]]*=>|[A-Za-z_$][A-Za-z0-9_$]*[[:blank:]]*=>).*)$
^[[:blank:]]*((export[[:blank:]]+)?(default[[:blank:]]+)?(abstract[[:blank:]]+)?class[[:blank:]]+[A-Za-z_$][A-Za-z0-9_$]*.*)$`

// funcnameArgs are the -c flags that turn the headings on. The attributes file is written once per
// process beside the config; if it cannot be written, diffs keep Git's own headings.
var funcnameArgs = sync.OnceValue(func() []string {
	path := filepath.Join(filepath.Dir(configPath()), "diff.gitattributes")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil
	}
	if err := os.WriteFile(path, []byte(diffAttributes+userAttributes()), 0o644); err != nil {
		return nil
	}
	// x^ can never match, so a data file gets an empty heading instead of a guess.
	return []string{"-c", "core.attributesFile=" + path, "-c", "diff.echo-none.xfuncname=x^", "-c", "diff.echo-js.xfuncname=" + jsFuncname}
})

// userAttributes is the user's global attributes file, which echo's core.attributesFile would
// otherwise hide: the configured one, or Git's default under the XDG config directory.
func userAttributes() string {
	out, err := exec.Command("git", "config", "--global", "--path", "core.attributesFile").Output()
	path := strings.TrimSpace(string(out))
	if err != nil || path == "" {
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			home, _ := os.UserHomeDir()
			base = filepath.Join(home, ".config")
		}
		path = filepath.Join(base, "git", "attributes")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return "\n# The user's global attributes, which override echo's lines above.\n" + string(b)
}
