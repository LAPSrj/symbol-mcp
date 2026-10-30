<?php
// Declarations a CMS would provide. add_filter is left undeclared on purpose.

/**
 * @param string   $hook_name Hook to add the callback to.
 * @param callable $callback  Called when the hook runs.
 */
function add_action( $hook_name, $callback ): void {}

function apply_filters( string $hook_name, mixed $value ): mixed {
	return $value;
}
