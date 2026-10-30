<?php

namespace Shop;

function notice_classes(): string {
	return 'notice';
}

function configure( array $options = [] ): array {
	$options = Config::merge( $options, [ 'size' => 'lg' ] );
	$copy    = custom_merge( $options, [ 'ignored' => true ] );
	return $options;
}

function normalize( array $item ): array {
	return custom_merge( $item, [ 'label' => '' ] );
}
