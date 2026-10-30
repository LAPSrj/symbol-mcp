<?php

namespace Shop;

function setup(): void {
	$cart = new Cart();
	echo $cart->render();
}

function boot(): void {
	setup();
}

add_action( 'init', __NAMESPACE__ . '\\setup' );
add_action( 'init', 'setup' );
apply_filters( 'Shop\\setup', 1 );
if ( ! function_exists( 'Shop\\setup' ) ) {
	return;
}
\Shop\setup();
