.PHONY: install test test-ts test-py typecheck demo evals baseline compare

install:
	npm ci
	python3 -m pip install -r requirements-dev.txt

test: typecheck test-ts test-py

typecheck:
	npx tsc --noEmit

test-ts:
	npx tsx --test tests/*.test.ts

test-py:
	python3 -m pytest -q

demo:
	npm run demo

evals:
	cd evals && python3 -m agent_evals eval

baseline:
	cd evals && python3 -m agent_evals baseline --runs 5

compare:
	cd evals && python3 -m agent_evals compare
