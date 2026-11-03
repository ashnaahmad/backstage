# Examples: checks that challenge assumptions

These are illustrative examples, not universal API contracts or a test checklist.

## When a mock agrees with the same mistaken assumption

Suppose an adapter reads a stored quantity. The implementation calls `value.toNumber()`, and its mock returns an object with that method. The test passes. A supported real read path returns a primitive number, so the same implementation throws.

The mock established that the code handles the response the test author invented. It did not establish that the real dependency produces that response.

Investigate the dependency's actual contract and supported configuration. Exercise the relevant real write/read boundary with a small isolated fixture; then make the adapter and mocked cases reflect the observed, supported representations. Choose rejection or conversion according to the domain contract, rather than silently converting every unexpected value to zero.

The useful question is: **which assumption is shared by the implementation and its test, and what independent evidence could challenge it?** Real integration evidence and focused unit cases serve complementary purposes.
